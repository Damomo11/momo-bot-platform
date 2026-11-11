const fs = require('node:fs')
const path = require('node:path')
const { fork } = require('node:child_process')
const cron = require('node-cron')
const { environmentForValues } = require('./templateVariables')
const { invalidateMinecraftAccessTokenCache } = require('./authCache')
const { readRuntimeUpdates } = require('./runtimeUpdates')

const accountReconnectDelaysMs = [60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000]
const serverCircuitDelaysMs = [120_000, 300_000, 600_000, 1_200_000, 1_800_000]
// Bot 上线后的免费宽限期：连接、加载资源包等启动开销这段时间不收费，
// 让余额不够充值一小时的玩家也能先把 Bot 跑起来。
const BILLING_GRACE_MS = 3 * 60 * 1000
// 排行榜探测：状态轮询的节流下限（每次 runBaltopProbeScheduler 最多派发一轮）。
const BALTOP_PROBE_TICK_MS = 15_000

// 把 1..totalPages 均匀分配给 workers 份：每份是连续页码段，长度差不超过 1。
// 例：10 页 3 个 bot → [1-4],[5-7],[8-10]。
function distributeBaltopPages (totalPages, workers) {
  const pages = Math.max(1, Math.trunc(Number(totalPages) || 0))
  const count = Math.max(1, Math.trunc(Number(workers) || 0))
  const segments = []
  for (let index = 0; index < count; index++) {
    const start = Math.floor(index * pages / count) + 1
    const end = Math.floor((index + 1) * pages / count)
    if (start <= end) segments.push({ start, end })
  }
  return segments.length ? segments : [{ start: 1, end: pages }]
}

function timestamped (tag, message) {
  const time = new Date().toLocaleString('sv-SE', { hour12: false })
  return `[${time}] [${tag}] ${message}`
}

function isReleaseNewer (candidate, current) {
  const parse = value => {
    const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i)
    return match ? match.slice(1).map(Number) : null
  }
  const next = parse(candidate)
  const installed = parse(current)
  if (!next || !installed) return false
  for (let index = 0; index < 3; index++) {
    if (next[index] !== installed[index]) return next[index] > installed[index]
  }
  return false
}

class BotManager {
  constructor (db, config) {
    this.db = db
    this.config = config
    this.processes = new Map()
    this.onceReservations = new Map()
    this.accountLocks = new Map()
    this.schedules = new Map()
    this.profileAuthRecoveryAt = new Map()
    this.logs = new Map()
    this.relatedLogs = new Map()
    this.pendingTopUps = new Map()
    this.accountReconnects = new Map()
    this.serverFailureWindows = new Map()
    this.serverCircuits = new Map()
    this.reconnectTimers = new Map()
    this.runtimeControlRequests = new Map()
    this.accurateTimeOffsetMs = 0
    this.dailyAutomationTimer = null
    this.accurateTimeTimer = null
    this.timeSyncPromise = null
    // 排行榜探测：周期派发（startBaltopRound）与收集（collectBaltopRound）状态。
    this.baltopTimer = null
    this.baltopRound = null
    this.baltopReports = new Map()
  }

  sanitizedLogLines (message) {
    const text = String(message ?? '')
      .replace(/(["']?(?:access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|user[_ -]?code|verification[_ -]?(?:uri|url)(?:_complete)?)["']?\s*[:=]\s*["']?)([^\s,"'}\]]+)/gi, '$1[redacted]')
      .replace(/(authorization\s*[:=]\s*)([^\r\n]+)/gi, '$1[redacted]')
      .replace(/([?&](?:access_token|refresh_token|code)=)[^&\s]+/gi, '$1[redacted]')
      .trim()
    return text.split(/\r?\n/).filter(Boolean).slice(0, 20).map(line => line.slice(0, 2000))
  }

  appendStoredLog (id, category, level, message) {
    const botId = String(id || '')
    if (!botId) return
    const kind = category === 'related' ? 'related' : 'general'
    const fallback = kind === 'related' ? this.relatedLogs : this.logs
    for (const line of this.sanitizedLogLines(message)) {
      if (kind === 'general' && String(level) === 'stdout' && /^\[message:(?:public|private)\]/i.test(line)) continue
      const entry = { at: Date.now(), level: String(level || 'info'), message: line }
      // related 是玩家行为审计（命令调用、充值），同步打到终端方便实时盯；
      // general 主要是运行日志，走原有 console.log 的 bot: 前缀通道。
      if (kind === 'related') console.log(timestamped(`audit:${botId}`, line))
      if (typeof this.db.appendBotLog === 'function') {
        try {
          this.db.appendBotLog(botId, kind, entry.level, entry.message, entry.at)
          continue
        } catch (error) {
          console.warn(`[bot:${botId}] 持久化日志失败，暂存到内存：${error.message || error}`)
        }
      }
      const entries = fallback.get(botId) || []
      entries.push(entry)
      const limit = kind === 'related' ? 500 : 100
      if (entries.length > limit) entries.splice(0, entries.length - limit)
      fallback.set(botId, entries)
    }
  }

  listStoredLogs (id, category) {
    const botId = String(id || '')
    const kind = category === 'related' ? 'related' : 'general'
    const fallback = kind === 'related' ? this.relatedLogs : this.logs
    const memory = (fallback.get(botId) || []).map(entry => ({ ...entry }))
    if (typeof this.db.listBotLogs !== 'function') return memory
    const limit = kind === 'related' ? 500 : 100
    return [...this.db.listBotLogs(botId, kind), ...memory].slice(-limit)
  }

  appendLog (id, level, message) { this.appendStoredLog(id, 'general', level, message) }

  appendRelatedLog (id, level, message) { this.appendStoredLog(id, 'related', level, message) }

  listLogs (id) { return this.listStoredLogs(id, 'general') }

  listRelatedLogs (id) { return this.listStoredLogs(id, 'related') }

  // 事故复盘 P1（INC-2026-1105-01）：给 bot 子进程发 IPC 消息的唯一安全入口。
  // 子进程刚被 kill、IPC 管道半关闭的毫秒级窗口内，send() 会把 EPIPE/
  // ERR_IPC_CHANNEL_CLOSED 漏成异步 error 事件；管道全关后 send() 返回 false。
  // 调用方一律改走这里：已退出就丢弃该条消息（bot 都没了，消息不必送达），
  // 半关闭竞态由 child.on('error') 监听兜住，只记警告不再有权力杀进程。
  sendToBot (state, message) {
    if (!state?.child) return false
    if (state.exited || state.child.killed) return false
    try {
      return Boolean(state.child.send(message))
    } catch (error) {
      console.warn(`[bot] IPC send skipped (child exiting): ${error?.code || ''} ${error?.message || error}`)
      return false
    }
  }

  startDesiredBots () {
    for (const bot of this.db.listBots()) {
      if (bot.desiredState === 'running') this.start(bot.id).catch(error => this.setError(bot.id, error))
      this.syncSchedule(bot.id)
    }
    this.startDailyAutomationScheduler()
    this.startBaltopProbeScheduler()
  }

  accurateNow () { return this.now() + this.accurateTimeOffsetMs }

  shanghaiClock (timestamp = this.accurateNow()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(timestamp)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute) }
  }

  async syncAccurateTime () {
    if (this.config.timeSyncEnabled === false || typeof fetch !== 'function') return false
    if (this.timeSyncPromise) return this.timeSyncPromise
    const urls = Array.isArray(this.config.accurateTimeUrls) && this.config.accurateTimeUrls.length
      ? this.config.accurateTimeUrls
      : ['https://www.cloudflare.com/', 'https://www.baidu.com/']
    this.timeSyncPromise = (async () => {
      for (const url of urls) {
        const startedAt = Date.now()
        try {
          const response = await fetch(String(url), { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(5000) })
          const serverTime = Date.parse(response.headers.get('date') || '')
          if (!Number.isFinite(serverTime)) continue
          const finishedAt = Date.now()
          this.accurateTimeOffsetMs = serverTime + (finishedAt - startedAt) / 2 - finishedAt
          return true
        } catch {}
      }
      return false
    })().finally(() => { this.timeSyncPromise = null })
    return this.timeSyncPromise
  }

  startDailyAutomationScheduler () {
    if (this.dailyAutomationTimer) return
    const run = () => this.runDailyAutomations().catch(error => console.error('[daily-automation]', error))
    this.syncAccurateTime().finally(run)
    this.dailyAutomationTimer = setInterval(run, 30_000)
    this.accurateTimeTimer = setInterval(() => this.syncAccurateTime().catch(() => {}), 10 * 60_000)
    this.dailyAutomationTimer.unref?.()
    this.accurateTimeTimer.unref?.()
  }

  async runDailySignin (timestamp = this.now()) {
    if (typeof this.db.claimSmartBotDailyAction !== 'function') return
    const clock = this.shanghaiClock(timestamp)
    if (clock.minuteOfDay > 5) return
    for (const [botId, state] of this.processes) {
      if (!state?.reachedOnline) continue
      const bot = this.db.getBot(botId)
      if (!bot || (bot.mode !== 'smart' && bot.mode !== 'admin')) continue
      if (!this.db.claimSmartBotDailyAction(botId, 'signin', clock.date)) continue
      try {
        this.sendToBot(state, { type: 'smart_daily_action', action: 'signin', command: '/signin click' })
        this.appendRelatedLog(botId, 'schedule', `已执行 ${clock.date} 每日签到。`)
      } catch (error) {
        console.error(`[daily-signin:${botId}]`, error)
      }
    }
  }

  async runDailyAutomations () {
    if (typeof this.db.claimSmartBotDailyAction !== 'function') return
    const clock = this.shanghaiClock()
    if (clock.minuteOfDay < 2) return
    for (const [botId, state] of this.processes) {
      if (!state?.reachedOnline) continue
      const bot = this.db.getBot(botId)
      if (!bot || (bot.mode !== 'smart' && bot.mode !== 'admin')) continue
      const settings = this.db.getSmartBotSettings(botId)
      if (!settings.autoRenewEnabled) continue
      const pending = this.pendingTopUps.get(botId)
      if (pending && Date.now() - pending.createdAt < 60_000) continue
      if (pending) this.pendingTopUps.delete(botId)
      if (!this.db.claimSmartBotDailyAction(botId, 'auto_renew', clock.date)) continue
      const topUp = this.db.getSmartTopUpSettings()
      const amount = '1.00'
      const command = String(topUp.commandTemplate || '/pay {recipient} {amount}')
        .replace(/\{recipient\}/g, String(topUp.recipient || 'Damomo1'))
        .replace(/\{amount\}/g, amount)
      this.pendingTopUps.set(botId, { cents: 100, amount, sender: '', createdAt: Date.now(), silent: true })
      try {
        this.sendToBot(state, { type: 'smart_daily_action', action: 'auto_renew', command })
        this.appendRelatedLog(botId, 'schedule', `已执行 ${clock.date} 自动续费 1 C。`)
      } catch (error) {
        this.pendingTopUps.delete(botId)
        console.error(`[daily-auto-renew:${botId}]`, error)
      }
    }
  }

  // ============ 排行榜探测（/baltop 金钱榜） ============
  // 管理端勾选后：每个探测周期把 1..pages 均分给当前在线的管理专用 Bot，
  // bot 按页间隔逐页 /baltop <页码> 并把系统消息解析回传；全部收齐后
  // 按 serverKey 合并成总排行榜落库，供管理界面查看与 bal 公屏查询。
  // 只有 admin 模式（admin-runtime）的 Bot 参与探测与回复，普通智能 Bot 不动。

  onlineAdminBots (serverKey = null) {
    const rows = []
    for (const [botId, state] of this.processes) {
      if (!state?.reachedOnline) continue
      const bot = this.db.getBot(botId)
      if (!bot || bot.mode !== 'admin') continue
      if (serverKey && this.serverKey(bot) !== serverKey) continue
      rows.push({ botId, bot, state })
    }
    return rows
  }

  startBaltopProbeScheduler () {
    if (this.baltopTimer || typeof this.db.getBaltopSettings !== 'function') return
    const run = () => this.runBaltopProbeScheduler().catch(error => console.error('[baltop-probe]', error))
    this.baltopTimer = setInterval(run, BALTOP_PROBE_TICK_MS)
    this.baltopTimer.unref?.()
    run()
  }

  // 每日固定小时（默认 4/10/16/20 点，北京时间）各跑一轮：
  // lastProbeAt 记的是「本小时窗口内已跑过」，同一小时不重复触发。
  // 探测期间查询不受影响（bal 查询直接读库，不需要等探测结束）。
  runBaltopProbeScheduler () {
    const settings = this.db.getBaltopSettings()
    if (!settings.enabled) return this.cancelBaltopRound()
    if (this.baltopRound) {
      // 一轮探测超时兜底：页冷却 × 页数 + 60s，正常由 bot 回报提前收尾。
      this.collectBaltopRound()
      return
    }
    const clock = this.shanghaiClock()
    const currentHour = Math.floor(clock.minuteOfDay / 60)
    if (!settings.hours.includes(currentHour)) {
      // 非探测小时：直接返回；lastProbeAt 只在探测小时窗口内比较，
      // 跨小时自然失效，下个探测小时会正常触发。
      return
    }
    // 探测小时窗口内：本小时已跑过（lastProbeAt 在本小时之后）则跳过。
    const hourStart = Math.floor(this.accurateNow() / 3_600_000) * 3_600_000
    if (settings.lastProbeAt >= hourStart) return
    this.startBaltopRound(settings)
  }

  cancelBaltopRound () {
    if (!this.baltopRound) return
    clearTimeout(this.baltopRound.timeoutTimer)
    this.baltopRound = null
    this.baltopReports.clear()
  }

  // 派发一轮探测：收集所有在线管理专用 Bot（按服务器分组），组内均分页码。
  // 页冷却固定 10 秒（防刷屏被踢），探测期间 bal 查询照常读库不受影响。
  startBaltopRound (settings) {
    const groups = new Map()
    for (const row of this.onlineAdminBots()) {
      const key = this.serverKey(row.bot)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(row)
    }
    if (!groups.size) return false
    const now = this.now()
    const assignments = []
    for (const [key, members] of groups) {
      const segments = distributeBaltopPages(settings.pages, members.length)
      members.forEach((member, index) => {
        const segment = segments[index] || segments[segments.length - 1]
        assignments.push({ serverKey: key, ...member, start: segment.start, end: segment.end })
      })
    }
    const pageDelayMs = Math.max(1000, settings.pageDelayMs)
    const expected = assignments.length
    const collectDelay = pageDelayMs * settings.pages + 60_000
    this.baltopRound = { startedAt: now, expected, pageDelayMs, pages: settings.pages, reported: 0 }
    this.baltopReports.clear()
    const finish = () => this.collectBaltopRound()
    this.baltopRound.timeoutTimer = setTimeout(finish, collectDelay)
    this.baltopRound.timeoutTimer.unref?.()
    this.db.markBaltopProbe(now)
    for (const assignment of assignments) {
      this.sendToBot(assignment.state, {
        type: 'baltop_probe',
        startPage: assignment.start,
        endPage: assignment.end,
        pageDelayMs
      })
      this.appendRelatedLog(assignment.botId, 'schedule', `排行榜探测开始：第 ${assignment.start}-${assignment.end} 页（共 ${settings.pages} 页，页冷却 ${Math.round(pageDelayMs / 1000)} 秒）。`)
    }
    console.log(`[baltop-probe] round started: ${expected} bot(s), pages 1-${settings.pages}`)
    return true
  }

  // 收尾合并：按 serverKey 各自落库；缺报的 bot 只记日志不影响其他组。
  collectBaltopRound () {
    const round = this.baltopRound
    if (!round) return
    clearTimeout(round.timeoutTimer)
    this.baltopRound = null
    const merged = new Map()
    for (const report of this.baltopReports.values()) {
      if (!Array.isArray(report?.entries) || !report?.serverKey) continue
      if (!merged.has(report.serverKey)) merged.set(report.serverKey, [])
      merged.get(report.serverKey).push(...report.entries)
    }
    this.baltopReports.clear()
    for (const [serverKey, entries] of merged) {
      const unique = new Map()
      for (const entry of entries) {
        const name = String(entry?.name || '').trim()
        if (!name) continue
        unique.set(name.toLowerCase(), { ...entry, name })
      }
      const rows = [...unique.values()].sort((a, b) => Number(a.rank) - Number(b.rank))
      if (typeof this.db.replaceBaltopEntries !== 'function') continue
      this.db.replaceBaltopEntries(serverKey, rows, round.startedAt)
      console.log(`[baltop-probe] server ${serverKey}: ${rows.length} entries saved`)
      // 探测结果属平台数据，记到本轮参与的第一个管理 bot 的相关日志，管理页可见。
      const witness = this.onlineAdminBots(serverKey)[0]
      if (witness) this.appendRelatedLog(witness.botId, 'schedule', `排行榜探测完成：${serverKey} 共入库 ${rows.length} 名玩家（第 1-${round.pages} 页）。`)
    }
  }

  // 供 handleMessage 转发 bot 回报的解析结果。report 缺省 serverKey 时按 bot 当前服务器。
  handleBaltopReport (id, state, report = {}) {
    if (!this.baltopRound) return false
    const bot = this.db.getBot(id)
    if (!bot) return false
    const serverKey = String(report.serverKey || this.serverKey(bot))
    this.baltopReports.set(id, { serverKey, entries: Array.isArray(report.entries) ? report.entries : null })
    if (this.baltopRound) {
      this.baltopRound.reported += 1
      if (this.baltopRound.reported >= this.baltopRound.expected) this.collectBaltopRound()
    }
    return true
  }

  // 游戏内 bal 查询：任意玩家公屏输入 bal ID，管理专用 Bot（admin 模式）
  // 查库后自己公屏回复；探测进行中查询照常读上一轮快照，不等待探测结束。
  // 榜上没有（含 100 页外、未入榜）：如实回「未找到」，不猜数据。
  handleBaltopQuery (id, state, payload = {}) {
    const name = String(payload?.name || '').trim()
    if (!name) return false
    const bot = this.db.getBot(id)
    if (!bot || bot.mode !== 'admin') return false
    if (!state?.reachedOnline) return false
    const serverKey = String(payload.serverKey || this.serverKey(bot))
    if (typeof this.db.getBaltopEntry !== 'function') return false
    const entry = this.db.getBaltopEntry(serverKey, name)
    // rank=null 表示「查无此人」：bot 侧按未找到文案回复。
    this.sendToBot(state, {
      type: 'baltop_reply',
      name: entry ? entry.name : name,
      rank: entry ? entry.rank : null,
      balance: entry ? entry.balance : '',
      requester: String(payload?.username || ''),
      updatedAt: entry ? entry.updatedAt : 0
    })
    return true
  }

  // 供平台管理界面展示：探测开关、快照统计（按服务器分组）。
  baltopStatus () {
    const settings = this.db.getBaltopSettings()
    const servers = new Map()
    if (typeof this.db.listBaltopEntries === 'function') {
      for (const bot of this.db.listBots()) {
        const key = this.serverKey(bot)
        if (servers.has(key)) continue
        const rows = this.db.listBaltopEntries(key, { limit: 500 })
        servers.set(key, rows)
      }
    }
    const round = this.baltopRound
    return {
      settings: { ...settings },
      probing: Boolean(round),
      probeStartedAt: round?.startedAt || 0,
      servers: [...servers.entries()].map(([serverKey, rows]) => {
        const online = this.onlineAdminBots(serverKey)
        return {
          serverKey,
          entryCount: rows.length,
          entries: rows,
          onlineBots: online.map(row => ({ id: row.botId, label: row.bot.label }))
        }
      })
    }
  }

  publicBot (bot) {
    if (!bot) return null
    let oauth = null
    try { oauth = bot.oauthJson ? JSON.parse(bot.oauthJson) : null } catch {}
    if (oauth?.expiresAt <= Date.now()) oauth = null
    let templateVariables = {}
    try { templateVariables = bot.templateVarsJson ? JSON.parse(bot.templateVarsJson) : {} } catch {}
    const { templateProjectPath, templateVarsJson, oauthJson, billingRemainderMicros, ...safe } = bot
    const prices = this.db.getModePrices()
    const smartSchedules = (bot.mode === 'smart' || bot.mode === 'admin') && typeof this.db.getSmartBotScheduleStatus === 'function' ? this.db.getSmartBotScheduleStatus(bot.id) : null
    const state = this.processes.get(bot.id)
    const runtimeVersion = state?.runtimeVersion || this.readPackageVersion(state?.instancePath)
    const latestRuntimeVersion = this.readPackageVersion(path.join(this.config.root || '', bot.mode === 'signin' ? 'signin-runtime' : bot.mode === 'admin' ? 'admin-runtime' : 'smart-runtime'))
    const updateAvailable = (bot.mode === 'smart' || bot.mode === 'admin') && Boolean(state) && isReleaseNewer(latestRuntimeVersion, runtimeVersion)
    const momocExempt = (bot.mode === 'smart' || bot.mode === 'admin') && typeof this.db.isSmartBotMomocExempt === 'function' ? this.db.isSmartBotMomocExempt(bot.id) : false
    return { ...safe, minecraftVersion: this.protocolVersions(bot)[0], billingMode: bot.mode === 'signin' ? 'once' : 'hourly', priceMomoc: bot.mode === 'signin' ? prices.signinOncePrice : prices.smartHourlyPrice, momocExempt, allowScheduling: bot.mode === 'signin', scheduleEnabled: Boolean(bot.scheduleEnabled), oauth, smartSchedules, runtimeVersion, latestRuntimeVersion, updateAvailable, logs: [] }
  }

  readPackageVersion (directory) {
    if (!directory) return ''
    try {
      const value = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
      return String(value.version || '')
    } catch {
      return ''
    }
  }

  list (userId = null) {
    return this.db.listBots(userId).map(bot => this.publicBot(bot))
  }

  runningSmartBotCount () {
    let count = 0
    for (const id of this.processes.keys()) {
      const bot = this.db.getBot(id)
      if (bot?.mode === 'smart' || bot?.mode === 'admin') count += 1
    }
    return count
  }

  protocolVersions (bot) {
    const configured = String(bot.minecraftVersion || '').trim()
    const isZenox = String(bot.serverHost || '').trim().toLowerCase() === 'mc.zenoxs.cn'
    return [isZenox ? '1.21.11' : configured]
  }

  now () {
    return typeof this.config.now === 'function' ? Number(this.config.now()) : Date.now()
  }

  reconnectDelays () {
    if (Array.isArray(this.config.reconnectDelaysMs) && this.config.reconnectDelaysMs.length) return this.config.reconnectDelaysMs.map(Number)
    if (Number.isFinite(Number(this.config.reconnectDelayMs))) return [Math.max(0, Number(this.config.reconnectDelayMs))]
    return accountReconnectDelaysMs
  }

  circuitDelays () {
    return Array.isArray(this.config.serverCircuitDelaysMs) && this.config.serverCircuitDelaysMs.length
      ? this.config.serverCircuitDelaysMs.map(Number)
      : serverCircuitDelaysMs
  }

  serverKey (bot) {
    return `${String(bot?.serverHost || '').trim().toLowerCase()}:${Number(bot?.serverPort || 25565)}`
  }

  retryJitter (key, failureCount) {
    const ratio = Math.min(0.5, Math.max(0, Number(this.config.reconnectJitterRatio ?? 0.2)))
    if (!ratio) return 1
    let hash = 2166136261
    for (const character of `${key}:${failureCount}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
    const unit = (hash >>> 0) / 0xffffffff
    return 1 - ratio + unit * ratio * 2
  }

  recordAccountReconnectFailure (bot) {
    const now = this.now()
    const accountId = String(bot.accountId || bot.id)
    const current = this.accountReconnects.get(accountId) || { failures: 0, nextRetryAt: 0 }
    const failures = current.failures + 1
    const delays = this.reconnectDelays()
    const baseDelay = Math.max(0, delays[Math.min(failures - 1, delays.length - 1)] || 0)
    const delayMs = Math.round(baseDelay * this.retryJitter(accountId, failures))
    const next = { failures, lastFailureAt: now, nextRetryAt: now + delayMs }
    this.accountReconnects.set(accountId, next)
    return { ...next, delayMs }
  }

  recordServerConnectionFailure (bot, botId) {
    const now = this.now()
    const key = this.serverKey(bot)
    const windowMs = Math.max(1, Number(this.config.serverFailureWindowMs ?? 60_000))
    const threshold = Math.max(2, Number(this.config.serverCircuitThreshold ?? 3))
    const recent = this.serverFailureWindows.get(key) || new Map()
    for (const [accountId, failedAt] of recent) {
      if (now - failedAt > windowMs) recent.delete(accountId)
    }
    recent.set(String(bot.accountId || bot.id), now)
    this.serverFailureWindows.set(key, recent)

    let circuit = this.serverCircuits.get(key)
    if (circuit?.probeBotId === botId) {
      const delays = this.circuitDelays()
      circuit.probeIndex = Math.min(circuit.probeIndex + 1, delays.length - 1)
      circuit.probeBotId = null
      circuit.nextProbeAt = now + Math.max(1, delays[circuit.probeIndex])
      this.deferCircuitReconnects(key, circuit)
    } else if (!circuit && recent.size >= threshold) {
      const delays = this.circuitDelays()
      circuit = { openedAt: now, probeIndex: 0, probeBotId: null, nextProbeAt: now + Math.max(1, delays[0]) }
      this.serverCircuits.set(key, circuit)
      this.deferCircuitReconnects(key, circuit)
      console.warn(`[server:${key}] connection circuit opened after ${recent.size} accounts failed`)
    }
    return circuit || null
  }

  deferCircuitReconnects (serverKey, circuit) {
    const now = this.now()
    const waiting = [...this.reconnectTimers.entries()]
    for (const [botId, scheduled] of waiting) {
      const waitingBot = this.db.getBot(botId)
      if (!waitingBot || this.serverKey(waitingBot) !== serverKey) continue
      const dueAt = Math.max(scheduled.dueAt, circuit.nextProbeAt)
      this.db.updateBotRuntime(botId, { runtimeState: 'circuit_open', lastError: `服务器连接已熔断，${this.reconnectWaitText(dueAt - now)}后检查恢复状态。` })
      this.scheduleReconnectAt(botId, scheduled.pricing, dueAt)
    }
  }

  releaseCircuitProbe (id) {
    const bot = this.db.getBot(id)
    const circuit = bot && this.serverCircuits.get(this.serverKey(bot))
    if (!circuit || circuit.probeBotId !== id) return
    circuit.probeBotId = null
    circuit.nextProbeAt = this.now()
    this.deferCircuitReconnects(this.serverKey(bot), circuit)
  }

  reconnectWaitText (milliseconds) {
    const seconds = Math.max(1, Math.ceil(milliseconds / 1000))
    return seconds < 120 ? `${seconds} 秒` : `${Math.ceil(seconds / 60)} 分钟`
  }

  cancelReconnect (id) {
    const scheduled = this.reconnectTimers.get(id)
    if (scheduled) clearTimeout(scheduled.timer)
    this.reconnectTimers.delete(id)
  }

  scheduleReconnectAt (id, pricing, dueAt) {
    this.cancelReconnect(id)
    const delayMs = Math.max(0, dueAt - this.now())
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(id)
      this.runScheduledReconnect(id, pricing)
    }, delayMs)
    timer.unref()
    this.reconnectTimers.set(id, { timer, dueAt, pricing })
  }

  scheduleAutomaticReconnect (id, exitedState, reason, includeServerFailure = true) {
    const bot = this.db.getBot(id)
    if (!bot || bot.desiredState !== 'running') return false
    const retry = this.recordAccountReconnectFailure(bot)
    const circuit = includeServerFailure ? this.recordServerConnectionFailure(bot, id) : this.serverCircuits.get(this.serverKey(bot))
    const now = this.now()
    const dueAt = Math.max(retry.nextRetryAt, circuit?.nextProbeAt || 0)
    const waitMs = Math.max(0, dueAt - now)
    const circuitOpen = Boolean(circuit)
    this.db.updateBotRuntime(id, {
      runtimeState: circuitOpen ? 'circuit_open' : 'reconnecting',
      startedAt: null,
      oauthJson: '',
      lastError: `${reason}；连续失败 ${retry.failures} 次，${circuitOpen ? '服务器连接已熔断，最早' : ''}${this.reconnectWaitText(waitMs)}后重试。`
    })
    this.scheduleReconnectAt(id, {
      billingMode: exitedState.billingMode,
      priceMomoc: exitedState.priceMomoc,
      protocolIndex: exitedState.protocolIndex
    }, dueAt)
    return true
  }

  runScheduledReconnect (id, pricing) {
    const bot = this.db.getBot(id)
    if (!bot || bot.desiredState !== 'running' || this.processes.has(id)) return
    const now = this.now()
    const account = this.accountReconnects.get(String(bot.accountId || bot.id))
    if (account?.nextRetryAt > now) return this.scheduleReconnectAt(id, pricing, account.nextRetryAt)

    const circuit = this.serverCircuits.get(this.serverKey(bot))
    if (circuit) {
      if (circuit.nextProbeAt > now || (circuit.probeBotId && circuit.probeBotId !== id)) {
        const dueAt = Math.max(circuit.nextProbeAt, now + 10_000)
        this.db.updateBotRuntime(id, { runtimeState: 'circuit_open', lastError: `服务器连接已熔断，${this.reconnectWaitText(dueAt - now)}后检查恢复状态。` })
        return this.scheduleReconnectAt(id, pricing, dueAt)
      }
      circuit.probeBotId = id
      circuit.nextProbeAt = now + Math.max(1, Number(this.config.serverProbeStableMs ?? 120_000))
    }

    try {
      this.launchAttempt(bot, pricing.protocolIndex, pricing)
    } catch (error) {
      if (circuit?.probeBotId === id) {
        circuit.probeBotId = null
        const delays = this.circuitDelays()
        circuit.probeIndex = Math.min(circuit.probeIndex + 1, delays.length - 1)
        circuit.nextProbeAt = now + Math.max(1, delays[circuit.probeIndex])
        this.deferCircuitReconnects(this.serverKey(bot), circuit)
      }
      this.releaseOnceReservation(id, pricing)
      if (this.accountLocks.get(bot.accountId) === id) this.accountLocks.delete(bot.accountId)
      this.setError(id, error)
    }
  }

  armStableConnection (id, state) {
    const bot = this.db.getBot(id)
    if (!bot) return
    const accountStableMs = Math.max(1, Number(this.config.accountReconnectStableMs ?? 300_000))
    state.accountStableTimer = setTimeout(() => {
      if (this.processes.get(id) === state && state.reachedOnline) this.accountReconnects.delete(String(bot.accountId || bot.id))
    }, accountStableMs)
    state.accountStableTimer.unref()

    const key = this.serverKey(bot)
    const circuit = this.serverCircuits.get(key)
    if (circuit?.probeBotId !== id) return
    const probeStableMs = Math.max(1, Number(this.config.serverProbeStableMs ?? 120_000))
    state.circuitStableTimer = setTimeout(() => {
      if (this.processes.get(id) !== state || !state.reachedOnline || this.serverCircuits.get(key)?.probeBotId !== id) return
      this.serverCircuits.delete(key)
      this.serverFailureWindows.delete(key)
      console.log(`[server:${key}] connection circuit closed after a stable probe`)
      const waiting = [...this.reconnectTimers.entries()].filter(([botId]) => this.serverKey(this.db.getBot(botId)) === key)
      waiting.forEach(([botId, scheduled], index) => {
        const waitingBot = this.db.getBot(botId)
        const account = waitingBot && this.accountReconnects.get(String(waitingBot.accountId || waitingBot.id))
        const dueAt = Math.max(this.now() + index * 5_000, account?.nextRetryAt || 0)
        this.db.updateBotRuntime(botId, { runtimeState: 'reconnecting', lastError: `服务器连接已恢复，${this.reconnectWaitText(dueAt - this.now())}后重试。` })
        this.scheduleReconnectAt(botId, scheduled.pricing, dueAt)
      })
    }, probeStableMs)
    state.circuitStableTimer.unref()
  }

  async start (id, actorUserId = null) {
    const bot = this.db.getBot(id)
    if (!bot) throw new Error('机器人不存在。')
    if (actorUserId && bot.userId !== actorUserId) throw new Error('无权操作这个机器人。')
    if (this.processes.has(id) || bot.desiredState === 'running' || (bot.runtimeState && bot.runtimeState !== 'stopped')) return this.publicBot(bot)
    const now = this.now()
    const accountReconnect = this.accountReconnects.get(String(bot.accountId || bot.id))
    if (accountReconnect?.nextRetryAt > now) throw new Error(`这个微软账号连接失败次数过多，请在 ${this.reconnectWaitText(accountReconnect.nextRetryAt - now)}后重试。`)
    const circuit = this.serverCircuits.get(this.serverKey(bot))
    if (circuit) throw new Error(`目标服务器连接已熔断，请在 ${this.reconnectWaitText(Math.max(0, circuit.nextProbeAt - now))}后等待平台自动探测。`)
    if (bot.accountAuthState !== 'authorized') throw new Error('这个微软账号尚未完成 OAuth2 授权。')
    const accountOwner = this.accountLocks.get(bot.accountId)
    if (accountOwner && accountOwner !== id) throw new Error('这个微软账号已有其他模板正在运行。')
    const runtimeSettings = typeof this.db.getRuntimeSettings === 'function' ? this.db.getRuntimeSettings() : { maxRunningBots: 0 }
    if ((bot.mode === 'smart' || bot.mode === 'admin') && runtimeSettings.maxRunningBots > 0 && this.runningSmartBotCount() >= runtimeSettings.maxRunningBots) {
      throw new Error(`平台智能 Bot 运行数已达到上限 (${runtimeSettings.maxRunningBots})。`)
    }
    const user = this.db.getUser(bot.userId)
    if (!user) throw new Error('用户不存在。')
    const prices = this.db.getModePrices()
    const price = bot.mode === 'signin' ? prices.signinOncePrice : prices.smartHourlyPrice
    const momocExempt = (bot.mode === 'smart' || bot.mode === 'admin') && typeof this.db.isSmartBotMomocExempt === 'function' && this.db.isSmartBotMomocExempt(bot.id)
    // 智能 Bot 余额门槛只拦“负数/欠费”：启动后有 3 分钟免费宽限期，
    // 余额不够付一分钟的也允许先跑起来，宽限期结束后再由计费逻辑按余额停机。
    if ((bot.mode === 'smart' || bot.mode === 'admin') && !momocExempt && user.availableMomoc < 0) throw new Error('momoc 余额不足，无法启动机器人。')
    if (bot.mode === 'signin') {
      const reservation = this.db.reserveOnce(id, price)
      if (!reservation.ok) throw new Error(`momoc 余额不足：${reservation.reason}`)
      this.onceReservations.set(id, price)
    }
    this.accountLocks.set(bot.accountId, id)
    this.cancelReconnect(id)

    this.db.updateBotRuntime(id, {
      desiredState: 'running',
      runtimeState: 'starting',
      lastError: '',
      oauthJson: ''
    })
    try {
      this.launchAttempt(this.db.getBot(id), 0)
    } catch (error) {
      this.releaseOnceReservation(id)
      if (this.accountLocks.get(bot.accountId) === id) this.accountLocks.delete(bot.accountId)
      this.db.updateBotRuntime(id, { desiredState: 'stopped', runtimeState: 'stopped', lastError: error.message || String(error) })
      throw error
    }
    return this.publicBot(this.db.getBot(id))
  }

  launchAttempt (bot, protocolIndex, pricing = null) {
    if (!bot || this.processes.has(bot.id)) return
    const project = this.prepareProject(bot)
    const versions = this.protocolVersions(bot)
    const safeIndex = Math.min(Math.max(0, protocolIndex), versions.length - 1)
    const activeVersion = versions[safeIndex]
    const prices = this.db.getModePrices()
    const billingMode = bot.mode === 'signin' ? 'once' : 'hourly'
    const priceMomoc = bot.mode === 'signin' ? prices.signinOncePrice : prices.smartHourlyPrice
    const cacheFolder = path.join(this.config.authCacheRoot, 'accounts', bot.accountId)
    let templateVariables = {}
    try { templateVariables = bot.templateVarsJson ? JSON.parse(bot.templateVarsJson) : {} } catch {}
    fs.mkdirSync(cacheFolder, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(cacheFolder, 0o700) } catch {}

    this.db.updateBotRuntime(bot.id, { runtimeState: 'connecting', oauthJson: '' })
    this.appendLog(bot.id, 'info', `Launching Minecraft ${activeVersion || 'auto-detect'}.`)
    this.appendRelatedLog(bot.id, 'lifecycle', `Bot 启动（Minecraft ${activeVersion || '自动检测'}），正在连接服务器。`)
    const child = fork(project.entry, project.args, {
      cwd: project.instancePath,
      silent: true,
      execArgv: ['--require', path.join(__dirname, 'platformPreload.js')],
      env: {
        ...process.env,
        BOT_PLATFORM_INSTANCE_ID: bot.id,
        BOT_PLATFORM_MICROSOFT_EMAIL: bot.microsoftEmail,
        BOT_PLATFORM_SERVER_HOST: bot.serverHost,
        BOT_PLATFORM_SERVER_PORT: String(bot.serverPort),
        BOT_PLATFORM_MINECRAFT_VERSION: activeVersion,
        BOT_PLATFORM_PROFILES_FOLDER: cacheFolder,
        BOT_PLATFORM_BILLING_MODE: billingMode,
        BOT_PLATFORM_PRICE_MOMOC: String(priceMomoc),
        ...environmentForValues(templateVariables)
      }
    })
    const state = {
      child,
      instancePath: project.instancePath,
      runtimeVersion: project.runtimeVersion,
      accountId: bot.accountId,
      versions,
      protocolIndex: safeIndex,
      activeVersion,
      billingMode,
      priceMomoc,
      onceCharged: false,
      billingTimer: null,
      connectTimer: null,
      authTimer: null,
      killTimer: null,
      stopping: false,
      exited: false,
      retryPending: false,
      profileAuthRecoveryPending: false,
      disconnectPending: false,
      reachedOnline: false,
      failureKind: '',
      lastConnectionError: '',
      accountStableTimer: null,
      circuitStableTimer: null
    }
    this.processes.set(bot.id, state)
    console.log(`[bot:${bot.id}] connecting with Minecraft ${activeVersion || 'auto'}`)
    // 事故复盘 P1（INC-2026-1105-01）：子进程退出窗口内给 IPC 发消息会触发
    // EPIPE / ERR_IPC_CHANNEL_CLOSED 的 error 事件，没有监听就是 uncaughtException，
    // 上一版等于一条消息失败杀死整棵进程树。监听后降级为一条警告日志。
    child.on('error', error => {
      if (this.processes.get(bot.id) !== state) return
      if (state.exited) return
      console.warn(`[bot:${bot.id}] IPC channel error (child exiting or closed): ${error?.code || ''} ${error?.message || error}`)
    })
    child.stdout?.on('data', data => {
      const message = String(data).trim()
      if (!message) return
      console.log(`[bot:${bot.id}] ${message}`)
      this.appendLog(bot.id, 'stdout', message)
    })
    child.stderr?.on('data', data => {
      const message = String(data).trim()
      if (!message) return
      console.error(`[bot:${bot.id}] ${message}`)
      this.appendLog(bot.id, 'stderr', message)
    })
    child.on('message', message => this.handleMessage(bot.id, message))
    child.on('exit', (code, signal) => this.handleExit(bot.id, state, code, signal))
    this.armConnectionTimeout(bot.id, state)
  }

  prepareProject (bot) {
    const templatePath = path.resolve(this.config.root, bot.mode === 'signin' ? 'signin-runtime' : bot.mode === 'admin' ? 'admin-runtime' : 'smart-runtime')
    const packageFile = path.join(templatePath, 'package.json')
    if (!fs.existsSync(packageFile)) throw new Error('平台核心运行时缺少 package.json。')
    const instancePath = path.join(this.config.root, 'runtime', bot.id)
    fs.mkdirSync(instancePath, { recursive: true })
    fs.cpSync(templatePath, instancePath, {
      recursive: true,
      force: true,
      filter: source => path.basename(source) !== 'node_modules'
    })
    const packageJson = JSON.parse(fs.readFileSync(path.join(instancePath, 'package.json'), 'utf8'))
    const entryName = String(packageJson.botPlatform?.entry || packageJson.main || 'index.js')
    const entry = path.resolve(instancePath, entryName)
    if (!entry.startsWith(path.resolve(instancePath) + path.sep) || !fs.existsSync(entry)) throw new Error(`模板入口不存在：${entryName}`)
    const nodeModulesTarget = path.join(this.config.root, 'node_modules')
    const instanceModules = path.join(instancePath, 'node_modules')
    if (!fs.existsSync(instanceModules)) fs.symlinkSync(nodeModulesTarget, instanceModules, 'junction')
    const args = Array.isArray(packageJson.botPlatform?.args) ? packageJson.botPlatform.args.map(String) : []
    return { instancePath, entry, args, runtimeVersion: String(packageJson.version || '') }
  }

  syncModules (id) {
    const state = this.processes.get(id)
    if (!state) return false
    const modules = this.db.listBotModules(id)
    state.modules = modules
    const manifest = this.prepareModules(state.instancePath, modules)
    this.sendToBot(state, { type: 'reload_modules', modules: manifest })
    return true
  }

  syncUserAccess (userId) {
    const access = this.db.getUserBotSettings(userId)
    for (const [id, state] of this.processes) {
      const bot = this.db.getBot(id)
      if (bot?.userId !== userId) continue
      state.access = access
      this.sendToBot(state, { type: 'reload_access', access })
    }
  }

  syncSmartSettings (botId) {
    if (botId === '__all_top_up_settings__') return this.syncSmartTopUpSettings()
    const settings = this.db.getSmartBotSettings(botId)
    const state = this.processes.get(botId)
    if (state) {
      this.sendToBot(state, { type: 'smart_settings', settings })
    }
    return settings
  }

  syncSmartAutomation (botId) {
    if (typeof this.db.getSmartBotScheduleStatus !== 'function') return null
    const schedules = this.db.getSmartBotScheduleStatus(botId)
    const state = this.processes.get(botId)
    if (state) {
      this.sendToBot(state, { type: 'smart_automation', automation: schedules.automation })
    }
    return schedules
  }

  prepareModules (instancePath, modules) {
    const root = path.join(instancePath, '.platform-modules')
    fs.mkdirSync(root, { recursive: true })
    return modules.map(feature => {
      const file = path.join(root, `${feature.id}.js`)
      fs.writeFileSync(file, feature.source, 'utf8')
      return { id: feature.id, name: feature.name, file, variables: feature.variables }
    })
  }

  handleMessage (id, message) {
    const state = this.processes.get(id)
    if (!state) return
    if (message?.type === 'smart_request') {
      this.handleSmartRequest(id, state, message)
      return
    }
    if (message?.type === 'baltop_report') {
      this.handleBaltopReport(id, state, message.report || {})
      return
    }
    if (message?.type === 'related_log') {
      this.appendRelatedLog(id, message.level || 'audit', message.message)
      return
    }
    if (message?.type === 'oauth') {
      this.clearConnectionTimers(state)
      this.appendLog(id, 'info', 'Microsoft OAuth authorization is required.')
      this.db.updateBotRuntime(id, { runtimeState: 'auth_required', oauthJson: JSON.stringify(message.oauth) })
      this.db.updateMicrosoftAccountAuth(state.accountId, { authState: 'auth_required', oauthJson: JSON.stringify(message.oauth) })
      return
    }
    if (message?.type === 'protocol_failure') {
      state.failureKind = 'server'
      this.requestConnectionRetry(id, String(message.error || '登录前协议解析失败'))
      return
    }
    if (message?.type === 'profile_auth_failure') {
      state.failureKind = 'auth'
      this.requestProfileAuthRecovery(id, String(message.error || 'Minecraft profile authentication failed'))
      return
    }
    if (message?.type === 'template_success') {
      this.handleTemplateSuccess(id, state, message.detail)
      return
    }
    if (message?.type === 'module_success') {
      const feature = state.modules.find(row => row.id === message.moduleId && row.billingMode === 'once')
      if (!feature) return
      const result = this.db.chargeModule(id, feature.id, 'once', feature.priceMomoc, message.detail)
      if (!result.ok) {
        this.db.updateBotRuntime(id, { desiredState: 'stopped', lastError: `${feature.name} 计次收费失败，机器人已停止：${result.reason}` })
        this.stop(id).catch(error => this.setError(id, error))
      }
      return
    }
    if (message?.type === 'module_error') {
      const feature = state.modules.find(row => row.id === message.moduleId)
      this.appendLog(id, 'error', `${feature?.name || 'Feature module'} failed to load: ${message.error}`)
      this.db.updateBotRuntime(id, { lastError: `${feature?.name || '功能模块'}加载失败：${message.error}` })
      return
    }
    if (message?.type === 'resource_pack') {
      if (state.retryPending || state.fallbackPending || state.reachedOnline) return
      this.armConnectionTimeout(id, state)
      const phases = { requested: '服务器请求资源包', accepted: '已接受资源包', downloaded: '资源包已下载', loaded: '资源包已加载' }
      this.appendLog(id, 'info', phases[message.phase] || 'Processing server resource pack.')
      this.db.updateBotRuntime(id, { runtimeState: 'resource_pack', lastError: phases[message.phase] || '正在处理资源包' })
      return
    }
    if (message?.type === 'state') {
      if (state.retryPending || state.fallbackPending) return
      this.appendLog(id, 'info', `Runtime state: ${String(message.state || 'unknown')}`)
      if (['project_started', 'authenticated', 'logging_in'].includes(message.state)) this.armConnectionTimeout(id, state)
      if (message.state === 'project_started') {
        this.db.updateBotRuntime(id, { runtimeState: 'connecting' })
        return
      }
      if (message.state === 'authenticated') this.db.updateMicrosoftAccountAuth(state.accountId, { authState: 'authorized', minecraftName: message.minecraftName || '', lastError: '', oauthJson: '' })
      if (message.state === 'logging_in' && state.authTimer) {
        clearTimeout(state.authTimer)
        state.authTimer = null
      }
      if (message.state === 'stopped' && message.reason && !state.lastConnectionError) state.lastConnectionError = String(message.reason)
      const fields = { runtimeState: message.state, oauthJson: '' }
      if (message.minecraftName) fields.minecraftName = message.minecraftName
      if (message.state === 'online') {
        state.reachedOnline = true
        this.clearConnectionTimers(state)
        this.armStableConnection(id, state)
        fields.startedAt = Date.now()
        fields.lastError = ''
        if (state.billingMode === 'hourly') this.startBilling(id)
      }
      this.db.updateBotRuntime(id, fields)
      if (message.state === 'stopped') this.terminateDisconnectedRuntime(id, state)
      return
    }
    if (message?.type === 'error' && !state.retryPending && !state.fallbackPending) {
      state.lastConnectionError = String(message.error || 'unknown error')
      this.appendLog(id, 'error', message.error || 'unknown error')
      this.db.updateBotRuntime(id, { lastError: String(message.error || 'unknown error') })
    }
    if (message?.type === 'log') {
      this.appendLog(id, 'runtime', message.message)
      console.log(`[template:${id}] ${message.message}`)
    }
    if (message?.type === 'server_message') {
      this.appendLog(id, 'server', message.message)
      this.runDailySignin(this.now()).catch(error => console.error(`[daily-signin:${id}]`, error))
    }
  }

  syncSmartTopUpSettings () {
    const settings = this.db.getSmartTopUpSettings()
    this.pendingTopUps.clear()
    for (const [botId, state] of this.processes) {
      const bot = this.db.getBot(botId)
      if (bot?.mode !== 'smart') continue
      this.sendToBot(state, { type: 'smart_top_up_settings', settings })
    }
    return settings
  }

  handleSmartRequest (id, state, message) {
    const requestId = String(message.requestId || '')
    if (!requestId) return
    try {
      const result = this.executeSmartRequest(id, String(message.action || ''), message.payload || {})
      if (result && typeof result.then === 'function') {
        result.then(value => this.sendToBot(state, { type: 'smart_response', requestId, ok: true, result: value })).catch(error => {
          this.sendToBot(state, { type: 'smart_response', requestId, ok: false, error: error.message || String(error) })
        })
      } else {
        this.sendToBot(state, { type: 'smart_response', requestId, ok: true, result })
      }
    } catch (error) {
      this.sendToBot(state, { type: 'smart_response', requestId, ok: false, error: error.message || String(error) })
    }
  }

  executeSmartRequest (botId, action, payload) {
    const bot = this.db.getBot(botId)
    // admin 模式（管理专用 Bot）走同一套 smart 接口：命令、权限、充值、
    // 定时任务与探测全在内，普通智能 Bot 的入口不变。
    if (!bot || (bot.mode !== 'smart' && bot.mode !== 'admin')) throw new Error('智能 Bot 不存在。')
    const state = this.processes.get(botId)
    if (action === 'runtime_targets') {
      // Prefixes are intentionally exposed to running smart runtimes so an
      // online Bot can act as the in-game receiver for an offline Bot.
      // admin 模式 Bot 不进该列表：它是管理专用探测机，不参与代收上下线。
      return this.db.listBots().filter(row => row.mode === 'smart').map(row => {
        const settings = this.db.getSmartBotSettings(row.id)
        const prefixes = []
        for (const value of [settings.commandPrefix, row.minecraftName, row.accountMinecraftName]) {
          const prefix = String(value || '').trim()
          if (prefix && !prefixes.some(item => item.toLowerCase() === prefix.toLowerCase())) prefixes.push(prefix)
        }
        return {
          id: row.id,
          label: row.label,
          serverHost: row.serverHost,
          serverPort: row.serverPort,
          prefixes,
          runtimeState: row.runtimeState,
          desiredState: row.desiredState
        }
      }).filter(row => row.prefixes.length)
    }
    if (action === 'runtime_control') {
      const targetId = String(payload.targetBotId || botId)
      const target = this.db.getBot(targetId)
      if (!target || (target.mode !== 'smart' && target.mode !== 'admin')) throw new Error('目标智能 Bot 不存在。')
      if (String(target.serverHost || '') !== String(bot.serverHost || '') || Number(target.serverPort || 0) !== Number(bot.serverPort || 0)) return { allowed: false, reason: 'different_server', silent: true }
      const username = String(payload.username || '')
      const access = this.db.getSmartAccess(target.userId, username)
      if (access.blacklisted || !access.admin) return { allowed: false, silent: true }
      const operation = String(payload.operation || '').toLowerCase()
      if (!['start', 'stop'].includes(operation)) throw new Error('无效的 Bot 上下线操作。')
      const running = ['starting', 'connecting', 'authenticated', 'logging_in', 'online', 'reconnecting', 'restarting', 'resource_pack', 'auth_required', 'auth_refresh', 'circuit_open'].includes(String(target.runtimeState || '')) || target.desiredState === 'running'
      if (operation === 'start') {
        if (running) return { allowed: true, status: 'already_online', bot: this.publicBot(target) }
        const key = `${target.id}:start`
        const duplicate = this.runtimeControlRequests.get(key)
        if (duplicate && Date.now() - duplicate.createdAt < 1000) return duplicate.promise.then(result => ({ ...result, duplicate: true }))
        const promise = this.start(target.id).then(started => ({ allowed: true, status: 'starting', bot: started }))
        this.runtimeControlRequests.set(key, { createdAt: Date.now(), promise })
        promise.then(() => setTimeout(() => {
          if (this.runtimeControlRequests.get(key)?.promise === promise) this.runtimeControlRequests.delete(key)
        }, 1000).unref?.(), () => setTimeout(() => {
          if (this.runtimeControlRequests.get(key)?.promise === promise) this.runtimeControlRequests.delete(key)
        }, 1000).unref?.())
        return promise
      }
      if (!running) return { allowed: true, status: 'already_offline', bot: this.publicBot(target) }
      const key = `${target.id}:stop`
      const duplicate = this.runtimeControlRequests.get(key)
      if (duplicate && Date.now() - duplicate.createdAt < 1000) return duplicate.promise.then(result => ({ ...result, duplicate: true }))
      const promise = this.stop(target.id).then(stopped => ({ allowed: true, status: 'stopping', bot: stopped }))
      this.runtimeControlRequests.set(key, { createdAt: Date.now(), promise })
      promise.then(() => setTimeout(() => {
        if (this.runtimeControlRequests.get(key)?.promise === promise) this.runtimeControlRequests.delete(key)
      }, 1000).unref?.(), () => setTimeout(() => {
        if (this.runtimeControlRequests.get(key)?.promise === promise) this.runtimeControlRequests.delete(key)
      }, 1000).unref?.())
      return promise
    }
    if (action === 'settings') return { ...this.db.getSmartBotSettings(bot.id), topUp: this.db.getSmartTopUpSettings() }
    if (action === 'auto_renew_set') {
      const actor = this.db.getSmartAccess(bot.userId, String(payload.username || ''))
      if (actor.blacklisted || !actor.admin) return { allowed: false }
      const settings = this.db.setSmartBotSettings(botId, { autoRenewEnabled: Boolean(payload.enabled) })
      return { allowed: true, settings }
    }
    if (action === 'owner_balance') {
      const actor = this.db.getSmartAccess(bot.userId, String(payload.username || ''))
      if (actor.blacklisted || !actor.admin) return { allowed: false }
      const user = this.db.getUser(bot.userId)
      if (!user) throw new Error('用户不存在。')
      return { allowed: true, balance: user.momoc, availableBalance: user.availableMomoc }
    }
    if (action === 'top_up_prepare') {
      const actor = this.db.getSmartAccess(bot.userId, String(payload.username || ''))
      if (actor.blacklisted || !actor.admin) return { allowed: false }
      const amount = String(payload.amount || '')
      if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) throw new Error('充值金额必须是正数，最多两位小数。')
      const cents = Math.round(Number(amount) * 100)
      if (!Number.isSafeInteger(cents) || cents < 1 || cents > 100000000) throw new Error('充值金额必须在 0.01-1000000.00 之间。')
      const pending = this.pendingTopUps.get(botId)
      if (pending && Date.now() - pending.createdAt < 60000) throw new Error('上一笔充值仍在等待服务器确认。')
      const normalized = (cents / 100).toFixed(2)
      this.pendingTopUps.set(botId, { cents, amount: normalized, sender: String(payload.username || '').replace(/^#/, ''), createdAt: Date.now() })
      return { allowed: true, amount: normalized }
    }
    if (action === 'top_up_cancel') {
      const pending = this.pendingTopUps.get(botId)
      this.pendingTopUps.delete(botId)
      return { canceled: true, silent: Boolean(pending?.silent) }
    }
    if (action === 'top_up_confirm') {
      const pending = this.pendingTopUps.get(botId)
      const match = String(payload.amount || '').match(/^(\d+)\.(\d{2})$/)
      const cents = match ? Number(match[1]) * 100 + Number(match[2]) : 0
      if (!pending || Date.now() - pending.createdAt >= 60000 || cents !== pending.cents) return { confirmed: false }
      this.pendingTopUps.delete(botId)
      const recipient = this.db.getSmartTopUpSettings().recipient
      const balance = this.db.adjustMomoc(bot.userId, pending.cents / 100, 'tsl_top_up', `TSL 支付给 ${recipient} ${pending.amount} C`, botId)
      // 充值成功是资金变动，必须在 Bot 的「与我相关」日志里留下谁在什么时候充了多少。
      this.appendRelatedLog(botId, 'audit', `玩家 ${pending.sender || '未知'} 充值成功 ${pending.amount} TSL（支付给 ${recipient}），余额 ${balance} momoc。`)
      return { confirmed: true, amount: pending.amount, balance, sender: pending.sender, silent: Boolean(pending.silent) }
    }
    if (action === 'runtime_version') {
      // admin 模式读 admin-runtime（版本独立演进）；smart 读 smart-runtime。
      const runtime = readRuntimeUpdates(this.config.root, bot.mode)
      return { version: runtime.version, release: runtime.latestRelease, releases: runtime.releases }
    }
    if (action === 'ominous_schedule_get') return this.db.getSmartBotAutomation(botId)
    if (action === 'ominous_schedule_complete') return this.db.completeSmartBotOminousBottle(botId)
    if (action === 'fishing_schedule_get') return this.db.getSmartBotAutomation(botId)
    if (action === 'vault_auto_open_get') return this.db.getSmartBotAutomation(botId)
    if (action === 'periodic_right_click_get') return this.db.getSmartBotAutomation(botId)
    if (action === 'periodic_right_click_complete') return this.db.completeSmartBotPeriodicRightClick(botId)
    if (action === 'task_get') return { task: this.db.getSmartBotTask(botId, payload.name) }
    if (action === 'task_list') return { tasks: this.db.listSmartBotTasks(botId) }
    if (action === 'schedule_status') return this.db.getSmartBotScheduleStatus(botId)
    if (action === 'volatile_schedules_reset') {
      const automation = this.db.getSmartBotAutomation(botId)
      const tasks = this.db.listSmartBotTasks(botId).filter(task => task.intervalTicks != null && !task.schedulePersistent)
      const result = this.db.resetSmartBotVolatileSchedules(botId)
      if (automation.periodicRightClickEnabled) this.appendRelatedLog(botId, 'schedule', 'Bot 重启时自动关闭了非持久化定时任务「定时放置」。')
      for (const task of tasks) this.appendRelatedLog(botId, 'schedule', `Bot 重启时自动关闭了非持久化定时任务「${task.name}」。`)
      return result
    }
    if (action === 'task_schedule_complete') return { task: this.db.completeSmartBotTaskSchedule(botId, payload.name) }
    if (action === 'baltop_query') {
      const resolved = this.handleBaltopQuery(botId, state, payload)
      return { handled: Boolean(resolved) }
    }
    if (action === 'baltop_probe_run') {
      // 游戏内「探测」命令：手动立即触发一轮探测（管理员可用）。
      const actor = this.db.getSmartAccess(bot.userId, String(payload.username || ''))
      if (actor.blacklisted || !actor.admin) return { allowed: false, silent: true }
      const settings = this.db.getBaltopSettings()
      if (this.baltopRound) return { allowed: true, status: 'already_running' }
      this.startBaltopRound(settings)
      return { allowed: true, status: this.baltopRound ? 'started' : 'no_online_bot' }
    }
    if (action === 'baltop_status') {
      // 游戏内「探测」不带参数时查状态：开关/下次探测时间。
      const settings = this.db.getBaltopSettings()
      return {
        enabled: settings.enabled,
        pages: settings.pages,
        hours: settings.hours,
        pageDelayMs: settings.pageDelayMs,
        lastProbeAt: settings.lastProbeAt,
        probing: Boolean(this.baltopRound)
      }
    }
    const username = String(payload.username || '')
    const actor = this.db.getSmartAccess(bot.userId, username)
    const lock = this.db.getSmartBotLock(botId)

    if (action === 'access') return { ...actor, lock }
    if (actor.blacklisted) return { allowed: false, silent: true }

    if (action === 'runtime_restart_prepare') {
      if (!actor.admin) return { allowed: false, silent: true }
      if (lock.locked) return { allowed: false, locked: true }
      const state = this.processes.get(botId)
      if (!state) throw new Error('机器人当前没有运行。')
      if (!state.restartPending) {
        state.restartPending = true
        this.clearStateTimers(state)
        this.db.updateBotRuntime(botId, { desiredState: 'running', runtimeState: 'restarting', lastError: '', oauthJson: '' })
        this.appendLog(botId, 'info', `In-game admin ${actor.playerName || username} requested a runtime update restart.`)
      }
      return { allowed: true }
    }

    if (action === 'permission_query') {
      const role = String(payload.role || '')
      const permission = this.db.getSmartPermission(bot.userId, payload.target, role)
      return { allowed: true, exists: Boolean(permission), permission }
    }

    if (action === 'permission_add') {
      if (!actor.admin) return { allowed: false, silent: true }
      const role = String(payload.role || '')
      const minutes = Number(payload.minutes || 0)
      let expiresAt = null
      if (minutes) {
        if (!['whitelist', 'blacklist'].includes(role) || !Number.isInteger(minutes) || minutes < 1 || minutes > 525600) throw new Error('临时权限分钟数必须为 1-525600。')
        expiresAt = Date.now() + minutes * 60000
      }
      return { allowed: true, ...this.db.setSmartPermission(bot.userId, payload.target, role, { expiresAt, createdBy: actor.playerName }) }
    }

    if (action === 'permission_remove') {
      if (!actor.admin) return { allowed: false, silent: true }
      return { allowed: true, ...this.db.removeSmartPermission(bot.userId, payload.target, String(payload.role || '')) }
    }

    if (action === 'ominous_schedule_set') {
      if (!actor.whitelisted || lock.adminLocked) return { allowed: false, silent: true }
      const enabled = Boolean(payload.enabled)
      const settings = this.db.setSmartBotOminousBottle(botId, enabled)
      this.appendRelatedLog(botId, 'schedule', `玩家 ${actor.playerName || username.replace(/^#/, '')} ${enabled ? '开启' : '关闭'}了定时任务「定时灾厄之瓶」。`)
      return { allowed: true, settings }
    }

    if (action === 'fishing_schedule_set') {
      if (!actor.whitelisted || lock.adminLocked) return { allowed: false, silent: true }
      const enabled = Boolean(payload.enabled)
      const settings = this.db.setSmartBotFishing(botId, enabled, payload.intervalTicks)
      this.appendRelatedLog(botId, 'schedule', `玩家 ${actor.playerName || username.replace(/^#/, '')} ${enabled ? '开启' : '关闭'}了定时任务「自动钓鱼」。`)
      return { allowed: true, settings }
    }

    if (action === 'vault_auto_open_set') {
      if (!actor.whitelisted || lock.adminLocked) return { allowed: false, silent: true }
      const enabled = Boolean(payload.enabled)
      const settings = this.db.setSmartBotVaultAutoOpen(botId, enabled)
      this.appendRelatedLog(botId, 'schedule', `玩家 ${actor.playerName || username.replace(/^#/, '')} ${enabled ? '开启' : '关闭'}了定时任务「自动开宝库」。`)
      return { allowed: true, settings }
    }

    if (action === 'periodic_right_click_set') {
      if (!actor.whitelisted || lock.adminLocked) return { allowed: false, silent: true }
      const enabled = Boolean(payload.enabled)
      const settings = this.db.setSmartBotPeriodicRightClick(botId, {
        enabled,
        x: payload.x,
        y: payload.y,
        z: payload.z,
        intervalTicks: payload.intervalTicks
      })
      this.appendRelatedLog(botId, 'schedule', `玩家 ${actor.playerName || username.replace(/^#/, '')} ${enabled ? '开启' : '关闭'}了定时任务「定时放置」。`)
      return {
        allowed: true,
        settings
      }
    }

    if (action === 'task_schedule_set') {
      if (!actor.whitelisted || lock.adminLocked) return { allowed: false, silent: true }
      const enabled = payload.intervalTicks != null
      const task = this.db.scheduleSmartBotTask(botId, payload.name, payload.intervalTicks, payload.args)
      this.appendRelatedLog(botId, 'schedule', `玩家 ${actor.playerName || username.replace(/^#/, '')} ${enabled ? '开启' : '关闭'}了定时任务「${task.name}」。`)
      return { allowed: true, task }
    }

    if (action === 'lock_set') {
      const level = payload.level === 'admin' ? 'admin' : 'normal'
      const locked = Boolean(payload.locked)
      if (level === 'admin' && !actor.admin) return { allowed: false, silent: true }
      if (level === 'normal' && !actor.whitelisted) return { allowed: false, silent: true }
      if (level === 'normal' && lock.adminLocked) return { allowed: true, status: 'admin_locked', lock }
      if (locked && ((level === 'admin' && lock.adminLocked) || (level === 'normal' && lock.locked))) return { allowed: true, status: 'exists', lock }
      if (!locked && ((level === 'admin' && !lock.adminLocked) || (level === 'normal' && !lock.locked))) return { allowed: true, status: 'missing', lock }
      const next = locked
        ? this.db.setSmartBotLock(botId, { locked: true, adminLocked: level === 'admin', lockedBy: actor.playerName, reason: payload.reason })
        : this.db.setSmartBotLock(botId, { locked: false, adminLocked: false, lockedBy: '', reason: '' })
      return { allowed: true, status: locked ? 'locked' : 'unlocked', lock: next }
    }

    throw new Error('未知的智能 Bot 请求。')
  }

  handleTemplateSuccess (id, state, detail) {
    if (state.billingMode !== 'once' || state.onceCharged || state.retryPending || state.fallbackPending) return
    const result = this.db.chargeOnce(id, state.priceMomoc, detail)
    if (!result.ok) {
      this.releaseOnceReservation(id, state)
      state.stopping = true
      this.db.updateBotRuntime(id, { desiredState: 'stopped', lastError: `按次计费失败：${result.reason}` })
      this.stop(id).catch(error => this.setError(id, error))
      return
    }
    state.onceCharged = true
    this.onceReservations.delete(id)
    this.db.updateBotRuntime(id, { desiredState: 'stopped', runtimeState: 'completed', lastError: '' })
    setTimeout(() => this.stop(id).catch(error => this.setError(id, error)), 500).unref()
  }

  armConnectionTimeout (id, state) {
    if (state.connectTimer) clearTimeout(state.connectTimer)
    const timeoutMs = Math.max(1, Number(this.config.connectionTimeoutMs ?? 120000))
    const timeoutSeconds = Math.ceil(timeoutMs / 1000)
    state.connectTimer = setTimeout(() => {
      if (this.processes.get(id) !== state || state.stopping || state.reachedOnline) return
      const reason = `使用 Minecraft ${state.activeVersion || '自动检测'} 后 ${timeoutSeconds} 秒内仍未进入服务器。`
      this.requestConnectionRetry(id, reason)
    }, timeoutMs)
    state.connectTimer.unref()
  }

  requestConnectionRetry (id, reason) {
    const state = this.processes.get(id)
    const bot = state && this.db.getBot(id)
    if (!state || !bot || bot.desiredState !== 'running' || state.stopping || state.restartPending || state.disconnectPending || state.retryPending || state.fallbackPending || state.profileAuthRecoveryPending || state.reachedOnline) return Boolean(state?.retryPending || state?.fallbackPending)
    state.retryPending = true
    state.lastConnectionError = String(reason || '连接服务器失败')
    this.clearConnectionTimers(state)
    const version = state.activeVersion || '自动检测'
    this.db.updateBotRuntime(id, {
      runtimeState: 'reconnecting',
      lastError: `${reason}；正在为 Minecraft ${version} 安排安全重连。`,
      oauthJson: ''
    })
    this.appendLog(id, 'error', `${reason} Retrying Minecraft ${version}.`)
    console.warn(`[bot:${id}] ${reason} Retrying Minecraft ${version}.`)
    state.child.kill('SIGTERM')
    state.killTimer = setTimeout(() => {
      if (this.processes.get(id) === state) state.child.kill('SIGKILL')
    }, 5000)
    state.killTimer.unref()
    return true
  }

  // Keep old hot-reloaded timeout callbacks safe while changing fallback into
  // a same-version retry. New connections call requestConnectionRetry directly.
  requestProtocolFallback (id, reason) {
    return this.requestConnectionRetry(id, reason)
  }

  stopFailedConnection (id, reason) {
    return this.requestConnectionRetry(id, reason)
  }

  requestProfileAuthRecovery (id, reason) {
    const state = this.processes.get(id)
    if (!state || state.retryPending || state.fallbackPending || state.profileAuthRecoveryPending || state.reachedOnline) return false
    state.profileAuthRecoveryPending = true
    state.failureKind = 'auth'
    state.lastConnectionError = String(reason || 'Minecraft 登录凭据验证失败')
    this.clearConnectionTimers(state)
    const now = Date.now()
    const lastRecoveryAt = Number(this.profileAuthRecoveryAt.get(state.accountId) || 0)
    let cleared = 0
    if (now - lastRecoveryAt >= 5 * 60 * 1000) {
      const cacheFolder = path.join(this.config.authCacheRoot, 'accounts', state.accountId)
      cleared = invalidateMinecraftAccessTokenCache(cacheFolder)
      this.profileAuthRecoveryAt.set(state.accountId, now)
    }
    this.db.updateBotRuntime(id, {
      runtimeState: 'auth_refresh',
      lastError: `${reason} 正在刷新 Minecraft 登录凭据后重试。`,
      oauthJson: ''
    })
    console.warn(`[bot:${id}] profile authentication failed; cleared ${cleared} Minecraft access-token cache file(s)`)
    state.child.kill('SIGTERM')
    state.killTimer = setTimeout(() => {
      if (this.processes.get(id) === state) state.child.kill('SIGKILL')
    }, 5000)
    state.killTimer.unref()
    return true
  }

  clearConnectionTimers (state) {
    if (state.connectTimer) clearTimeout(state.connectTimer)
    if (state.authTimer) clearTimeout(state.authTimer)
    state.connectTimer = null
    state.authTimer = null
  }

  startBilling (id) {
    const state = this.processes.get(id)
    if (!state || state.billingTimer || state.billingMode !== 'hourly') return
    state.billingTimer = setTimeout(() => {
      state.billingTimer = null
      this.beginMinuteBilling(id, state)
    }, BILLING_GRACE_MS)
    state.billingTimer.unref?.()
    this.appendLog(id, 'info', `Billing starts in ${BILLING_GRACE_MS / 60000} minutes (grace period).`)
  }

  // 宽限期结束后才进入按分钟计费；余额不足时把 Bot 停下来并保留原因。
  beginMinuteBilling (id, state) {
    if (this.processes.get(id) !== state || state.stopping) return
    state.billingTimer = setInterval(() => {
      const result = this.db.chargeHourlyMinute(id, state.priceMomoc)
      if (!result.ok) {
        this.db.updateBotRuntime(id, { desiredState: 'stopped', lastError: `计费停止：${result.reason}` })
        this.stop(id).catch(error => this.setError(id, error))
        return
      }
    }, 60000)
  }

  terminateDisconnectedRuntime (id, state) {
    if (this.processes.get(id) !== state || state.stopping || state.restartPending || state.retryPending || state.fallbackPending || state.profileAuthRecoveryPending || state.disconnectPending) return
    state.disconnectPending = true
    this.clearStateTimers(state)
    this.appendLog(id, 'info', 'Minecraft connection ended; terminating the runtime before reconnecting.')
    state.child.kill('SIGTERM')
    state.killTimer = setTimeout(() => {
      if (this.processes.get(id) === state) state.child.kill('SIGKILL')
    }, 5000)
    state.killTimer.unref()
  }

  recoverDisconnectedRuntimes () {
    let recovered = 0
    for (const [id, state] of this.processes) {
      const bot = this.db.getBot(id)
      if (bot?.desiredState !== 'running' || bot.runtimeState !== 'stopped') continue
      this.terminateDisconnectedRuntime(id, state)
      if (state.disconnectPending) recovered += 1
    }
    return recovered
  }

  async stop (id, actorUserId = null) {
    const bot = this.db.getBot(id)
    if (!bot) throw new Error('机器人不存在。')
    if (actorUserId && bot.userId !== actorUserId) throw new Error('无权操作这个机器人。')
    this.cancelReconnect(id)
    this.releaseCircuitProbe(id)
    this.db.updateBotRuntime(id, { desiredState: 'stopped', runtimeState: 'stopping', oauthJson: '' })
    const state = this.processes.get(id)
    if (!state) {
      this.releaseOnceReservation(id)
      if (this.accountLocks.get(bot.accountId) === id) this.accountLocks.delete(bot.accountId)
      this.db.updateBotRuntime(id, { runtimeState: 'stopped', startedAt: null })
      return this.publicBot(this.db.getBot(id))
    }
    state.stopping = true
    this.releaseOnceReservation(id, state)
    this.clearStateTimers(state)
    state.child.kill('SIGTERM')
    state.killTimer = setTimeout(() => {
      if (this.processes.get(id) === state) state.child.kill('SIGKILL')
    }, 5000)
    state.killTimer.unref()
    return this.publicBot(this.db.getBot(id))
  }

  async restart (id, actorUserId = null) {
    const bot = this.db.getBot(id)
    if (!bot) throw new Error('机器人不存在。')
    if (actorUserId && bot.userId !== actorUserId) throw new Error('无权操作这个机器人。')
    if (bot.mode !== 'smart' && bot.mode !== 'admin') throw new Error('只有智能 Bot 支持版本更新重启。')
    const state = this.processes.get(id)
    if (!state) {
      // 进程已不在（异常停止后的残留状态）：归一化后走启动流程，避免卡死在 desiredState=running
      this.cancelReconnect(id)
      this.db.updateBotRuntime(id, { desiredState: 'stopped', runtimeState: 'stopped', startedAt: null })
      return this.start(id, actorUserId)
    }
    if (state.restartPending) return this.publicBot(bot)
    state.restartPending = true
    this.clearStateTimers(state)
    this.db.updateBotRuntime(id, { desiredState: 'running', runtimeState: 'restarting', lastError: '', oauthJson: '' })
    this.appendLog(id, 'info', 'User requested a runtime update restart.')
    state.child.kill('SIGTERM')
    state.killTimer = setTimeout(() => {
      if (this.processes.get(id) === state) state.child.kill('SIGKILL')
    }, 5000)
    state.killTimer.unref()
    return this.publicBot(this.db.getBot(id))
  }

  clearStateTimers (state) {
    this.clearConnectionTimers(state)
    if (state.billingTimer) { clearTimeout(state.billingTimer); clearInterval(state.billingTimer) }
    if (state.killTimer) clearTimeout(state.killTimer)
    if (state.accountStableTimer) clearTimeout(state.accountStableTimer)
    if (state.circuitStableTimer) clearTimeout(state.circuitStableTimer)
    state.billingTimer = null
    state.killTimer = null
    state.accountStableTimer = null
    state.circuitStableTimer = null
  }

  handleExit (id, exitedState, code, signal) {
    if (this.processes.get(id) !== exitedState) return
    const bot = this.db.getBot(id)
    // Older runtime versions exited cleanly without declaring an in-game restart.
    const legacyCleanRestart = Boolean(
      (bot?.mode === 'smart' || bot?.mode === 'admin') &&
      code === 0 &&
      !signal &&
      !exitedState.stopping &&
      !exitedState.disconnectPending &&
      !exitedState.retryPending &&
      !exitedState.fallbackPending &&
      !exitedState.profileAuthRecoveryPending
    )
    const plannedRestart = Boolean(exitedState.restartPending || legacyCleanRestart)
    this.appendLog(id, exitedState.stopping || plannedRestart ? 'info' : 'error', `Process exited: code=${code} signal=${signal || '-'}.`)
    exitedState.exited = true
    this.clearStateTimers(exitedState)
    this.processes.delete(id)
    this.pendingTopUps.delete(id)
    if (!bot) {
      if (this.accountLocks.get(exitedState.accountId) === id) this.accountLocks.delete(exitedState.accountId)
      return
    }

    if (plannedRestart && bot.desiredState === 'running') {
      this.db.updateBotRuntime(id, { runtimeState: 'restarting', startedAt: null, oauthJson: '', lastError: '' })
      setTimeout(() => {
        const current = this.db.getBot(id)
        if (!current || current.desiredState !== 'running' || this.processes.has(id)) return
        try {
          this.launchAttempt(current, exitedState.protocolIndex)
        } catch (error) {
          if (this.accountLocks.get(exitedState.accountId) === id) this.accountLocks.delete(exitedState.accountId)
          this.setError(id, error)
        }
      }, 500).unref()
      return
    }

    if ((exitedState.retryPending || exitedState.fallbackPending) && bot.desiredState === 'running') {
      const reason = exitedState.lastConnectionError || bot.lastError || '连接服务器失败'
      this.scheduleAutomaticReconnect(id, exitedState, reason, exitedState.failureKind !== 'auth')
      return
    }

    if (exitedState.profileAuthRecoveryPending && bot.desiredState === 'running') {
      const reason = exitedState.lastConnectionError || bot.lastError || 'Minecraft 登录凭据验证失败'
      this.scheduleAutomaticReconnect(id, exitedState, reason, false)
      return
    }

    if (exitedState.billingMode === 'once' && !exitedState.onceCharged && !exitedState.stopping) {
      this.releaseOnceReservation(id, exitedState)
      if (this.accountLocks.get(exitedState.accountId) === id) this.accountLocks.delete(exitedState.accountId)
      this.db.updateBotRuntime(id, { desiredState: 'stopped', runtimeState: 'stopped', startedAt: null, oauthJson: '', lastError: '执行未成功，不收费。' })
      return
    }

    this.db.updateBotRuntime(id, { runtimeState: 'stopped', startedAt: null, oauthJson: '' })
    if (bot.desiredState === 'running' && !exitedState.stopping) {
      const reason = exitedState.lastConnectionError || bot.lastError || `进程退出 code=${code} signal=${signal || ''}`
      this.scheduleAutomaticReconnect(id, exitedState, reason, exitedState.failureKind !== 'auth' && (exitedState.disconnectPending || exitedState.failureKind === 'server'))
      return
    }
    if (this.accountLocks.get(exitedState.accountId) === id) this.accountLocks.delete(exitedState.accountId)
  }

  async remove (id, actorUserId = null) {
    const bot = this.db.getBot(id)
    if (!bot) throw new Error('机器人不存在。')
    if (actorUserId && bot.userId !== actorUserId) throw new Error('无权操作这个机器人。')
    this.cancelReconnect(id)
    if (this.processes.has(id)) await this.stop(id, actorUserId)
    else {
      this.releaseOnceReservation(id)
      if (this.accountLocks.get(bot.accountId) === id) this.accountLocks.delete(bot.accountId)
    }
    this.removeSchedule(id)
    this.db.deleteBot(id)
    this.logs.delete(id)
    this.relatedLogs.delete(id)
    return true
  }

  setError (id, error) {
    console.error(`[bot:${id}]`, error)
    this.appendLog(id, 'error', error?.stack || error?.message || String(error))
    this.db.updateBotRuntime(id, { runtimeState: 'stopped', lastError: error.message || String(error) })
  }

  setSchedule (id, enabled, expression, actorUserId = null) {
    const bot = this.db.getBot(id)
    if (!bot) throw new Error('机器人不存在。')
    if (actorUserId && bot.userId !== actorUserId) throw new Error('无权操作这个机器人。')
    if (enabled && bot.mode !== 'signin') throw new Error('只有签到 Bot 可以定时运行。')
    if (enabled && !cron.validate(String(expression || ''))) throw new Error('定时计划格式无效。')
    const updated = this.db.updateBotSchedule(id, Boolean(enabled), enabled ? expression : '')
    this.syncSchedule(id)
    return this.publicBot(updated)
  }

  removeSchedule (id) {
    const task = this.schedules.get(id)
    if (task) task.destroy()
    this.schedules.delete(id)
  }

  syncSchedule (id) {
    this.removeSchedule(id)
    const bot = this.db.getBot(id)
    if (!bot?.scheduleEnabled || bot.mode !== 'signin' || !cron.validate(bot.scheduleCron)) return
    const task = cron.schedule(bot.scheduleCron, () => {
      if (this.processes.has(id) || this.accountLocks.has(bot.accountId)) {
        console.log(`[schedule:${id}] skipped because the bot or Microsoft account is busy`)
        return
      }
      this.start(id).catch(error => {
        console.error(`[schedule:${id}]`, error)
        this.db.updateBotRuntime(id, { desiredState: 'stopped', runtimeState: 'stopped', lastError: `定时启动失败：${error.message || error}` })
      })
    }, { timezone: 'Asia/Shanghai' })
    this.schedules.set(id, task)
  }

  releaseOnceReservation (id, state = null) {
    if (!this.onceReservations.has(id)) return
    const price = this.onceReservations.get(id) ?? state?.priceMomoc ?? 0
    this.db.releaseOnce(id, price)
    this.onceReservations.delete(id)
  }

  shutdown () {
    if (this.dailyAutomationTimer) clearInterval(this.dailyAutomationTimer)
    if (this.accurateTimeTimer) clearInterval(this.accurateTimeTimer)
    if (this.baltopTimer) clearInterval(this.baltopTimer)
    this.dailyAutomationTimer = null
    this.accurateTimeTimer = null
    this.baltopTimer = null
    this.cancelBaltopRound()
    for (const { timer } of this.reconnectTimers.values()) clearTimeout(timer)
    this.reconnectTimers.clear()
    for (const task of this.schedules.values()) task.destroy()
    this.schedules.clear()
    for (const [id] of this.processes) this.stop(id).catch(() => {})
  }
}

module.exports = BotManager
