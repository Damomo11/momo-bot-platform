const fs = require('node:fs')
const path = require('node:path')
const { fork } = require('node:child_process')
const cron = require('node-cron')
const { environmentForValues } = require('./templateVariables')
const { invalidateMinecraftAccessTokenCache } = require('./authCache')
const { readRuntimeUpdates } = require('./runtimeUpdates')

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
    this.pendingTopUps = new Map()
  }

  appendLog (id, level, message) {
    const botId = String(id || '')
    if (!botId) return
    const entries = this.logs.get(botId) || []
    const text = String(message ?? '')
      .replace(/(["']?(?:access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|user[_ -]?code|verification[_ -]?(?:uri|url)(?:_complete)?)["']?\s*[:=]\s*["']?)([^\s,"'}\]]+)/gi, '$1[redacted]')
      .replace(/(authorization\s*[:=]\s*)([^\r\n]+)/gi, '$1[redacted]')
      .replace(/([?&](?:access_token|refresh_token|code)=)[^&\s]+/gi, '$1[redacted]')
      .trim()
    for (const line of text.split(/\r?\n/).filter(Boolean).slice(0, 20)) {
      entries.push({ at: Date.now(), level: String(level || 'info'), message: line.slice(0, 2000) })
    }
    if (entries.length > 100) entries.splice(0, entries.length - 100)
    this.logs.set(botId, entries)
  }

  listLogs (id) {
    return (this.logs.get(String(id || '')) || []).map(entry => ({ ...entry }))
  }

  startDesiredBots () {
    for (const bot of this.db.listBots()) {
      if (bot.desiredState === 'running') this.start(bot.id).catch(error => this.setError(bot.id, error))
      this.syncSchedule(bot.id)
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
    const smartSchedules = bot.mode === 'smart' && typeof this.db.getSmartBotScheduleStatus === 'function' ? this.db.getSmartBotScheduleStatus(bot.id) : null
    const state = this.processes.get(bot.id)
    const runtimeVersion = state?.runtimeVersion || this.readPackageVersion(state?.instancePath)
    const latestRuntimeVersion = this.readPackageVersion(path.join(this.config.root || '', bot.mode === 'signin' ? 'signin-runtime' : 'smart-runtime'))
    const updateAvailable = bot.mode === 'smart' && Boolean(state) && isReleaseNewer(latestRuntimeVersion, runtimeVersion)
    return { ...safe, minecraftVersion: this.protocolVersions(bot)[0], billingMode: bot.mode === 'signin' ? 'once' : 'hourly', priceMomoc: bot.mode === 'signin' ? prices.signinOncePrice : prices.smartHourlyPrice, allowScheduling: bot.mode === 'signin', scheduleEnabled: Boolean(bot.scheduleEnabled), oauth, smartSchedules, runtimeVersion, latestRuntimeVersion, updateAvailable, logs: this.listLogs(bot.id) }
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
      if (bot?.mode === 'smart') count += 1
    }
    return count
  }

  protocolVersions (bot) {
    const configured = String(bot.minecraftVersion || '').trim()
    const isZenox = String(bot.serverHost || '').trim().toLowerCase() === 'mc.zenoxs.cn'
    return [isZenox ? '1.21.11' : configured]
  }

  async start (id, actorUserId = null) {
    const bot = this.db.getBot(id)
    if (!bot) throw new Error('机器人不存在。')
    if (actorUserId && bot.userId !== actorUserId) throw new Error('无权操作这个机器人。')
    if (this.processes.has(id)) return this.publicBot(bot)
    if (bot.accountAuthState !== 'authorized') throw new Error('这个微软账号尚未完成 OAuth2 授权。')
    const accountOwner = this.accountLocks.get(bot.accountId)
    if (accountOwner && accountOwner !== id) throw new Error('这个微软账号已有其他模板正在运行。')
    const runtimeSettings = typeof this.db.getRuntimeSettings === 'function' ? this.db.getRuntimeSettings() : { maxRunningBots: 0 }
    if (bot.mode === 'smart' && runtimeSettings.maxRunningBots > 0 && this.runningSmartBotCount() >= runtimeSettings.maxRunningBots) {
      throw new Error(`平台智能 Bot 运行数已达到上限 (${runtimeSettings.maxRunningBots})。`)
    }
    const user = this.db.getUser(bot.userId)
    if (!user) throw new Error('用户不存在。')
    const prices = this.db.getModePrices()
    const price = bot.mode === 'signin' ? prices.signinOncePrice : prices.smartHourlyPrice
    if (bot.mode === 'smart' && user.availableMomoc < price / 60) throw new Error('momoc 余额不足，无法启动机器人。')
    if (bot.mode === 'signin') {
      const reservation = this.db.reserveOnce(id, price)
      if (!reservation.ok) throw new Error(`momoc 余额不足：${reservation.reason}`)
      this.onceReservations.set(id, price)
    }
    this.accountLocks.set(bot.accountId, id)

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
      retryPending: false,
      profileAuthRecoveryPending: false,
      disconnectPending: false,
      reachedOnline: false
    }
    this.processes.set(bot.id, state)
    console.log(`[bot:${bot.id}] connecting with Minecraft ${activeVersion || 'auto'}`)
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
    const templatePath = path.resolve(this.config.root, bot.mode === 'signin' ? 'signin-runtime' : 'smart-runtime')
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
    state.child.send?.({ type: 'reload_modules', modules: manifest })
    return true
  }

  syncUserAccess (userId) {
    const access = this.db.getUserBotSettings(userId)
    for (const [id, state] of this.processes) {
      const bot = this.db.getBot(id)
      if (bot?.userId !== userId) continue
      state.access = access
      state.child.send?.({ type: 'reload_access', access })
    }
  }

  syncSmartSettings (botId) {
    if (botId === '__all_top_up_settings__') return this.syncSmartTopUpSettings()
    const settings = this.db.getSmartBotSettings(botId)
    const state = this.processes.get(botId)
    if (state) {
      try { state.child.send?.({ type: 'smart_settings', settings }) } catch (error) { console.warn(`[bot:${botId}] smart settings hot update failed: ${error.message || error}`) }
    }
    return settings
  }

  syncSmartAutomation (botId) {
    if (typeof this.db.getSmartBotScheduleStatus !== 'function') return null
    const schedules = this.db.getSmartBotScheduleStatus(botId)
    const state = this.processes.get(botId)
    if (state) {
      try { state.child.send?.({ type: 'smart_automation', automation: schedules.automation }) } catch (error) { console.warn(`[bot:${botId}] smart automation hot update failed: ${error.message || error}`) }
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
    if (message?.type === 'oauth') {
      this.clearConnectionTimers(state)
      this.appendLog(id, 'info', 'Microsoft OAuth authorization is required.')
      this.db.updateBotRuntime(id, { runtimeState: 'auth_required', oauthJson: JSON.stringify(message.oauth) })
      this.db.updateMicrosoftAccountAuth(state.accountId, { authState: 'auth_required', oauthJson: JSON.stringify(message.oauth) })
      return
    }
    if (message?.type === 'protocol_failure') {
      this.requestConnectionRetry(id, String(message.error || '登录前协议解析失败'))
      return
    }
    if (message?.type === 'profile_auth_failure') {
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
      const fields = { runtimeState: message.state, oauthJson: '' }
      if (message.minecraftName) fields.minecraftName = message.minecraftName
      if (message.state === 'online') {
        state.reachedOnline = true
        this.clearConnectionTimers(state)
        fields.startedAt = Date.now()
        fields.lastError = ''
        if (state.billingMode === 'hourly') this.startBilling(id)
      }
      this.db.updateBotRuntime(id, fields)
      if (message.state === 'stopped') this.terminateDisconnectedRuntime(id, state)
      return
    }
    if (message?.type === 'error' && !state.retryPending && !state.fallbackPending) {
      this.appendLog(id, 'error', message.error || 'unknown error')
      this.db.updateBotRuntime(id, { lastError: String(message.error || 'unknown error') })
    }
    if (message?.type === 'log') {
      this.appendLog(id, 'runtime', message.message)
      console.log(`[template:${id}] ${message.message}`)
    }
    if (message?.type === 'server_message') {
      this.appendLog(id, 'server', message.message)
    }
  }

  syncSmartTopUpSettings () {
    const settings = this.db.getSmartTopUpSettings()
    this.pendingTopUps.clear()
    for (const [botId, state] of this.processes) {
      const bot = this.db.getBot(botId)
      if (bot?.mode !== 'smart') continue
      try { state.child.send?.({ type: 'smart_top_up_settings', settings }) } catch (error) { console.warn(`[bot:${botId}] smart top-up settings hot update failed: ${error.message || error}`) }
    }
    return settings
  }

  handleSmartRequest (id, state, message) {
    const requestId = String(message.requestId || '')
    if (!requestId) return
    try {
      const result = this.executeSmartRequest(id, String(message.action || ''), message.payload || {})
      state.child.send?.({ type: 'smart_response', requestId, ok: true, result })
    } catch (error) {
      state.child.send?.({ type: 'smart_response', requestId, ok: false, error: error.message || String(error) })
    }
  }

  executeSmartRequest (botId, action, payload) {
    const bot = this.db.getBot(botId)
    if (!bot || bot.mode !== 'smart') throw new Error('智能 Bot 不存在。')
    if (action === 'settings') return { ...this.db.getSmartBotSettings(bot.id), topUp: this.db.getSmartTopUpSettings() }
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
      this.pendingTopUps.delete(botId)
      return { canceled: true }
    }
    if (action === 'top_up_confirm') {
      const pending = this.pendingTopUps.get(botId)
      const match = String(payload.amount || '').match(/^(\d+)\.(\d{2})$/)
      const cents = match ? Number(match[1]) * 100 + Number(match[2]) : 0
      if (!pending || Date.now() - pending.createdAt >= 60000 || cents !== pending.cents) return { confirmed: false }
      this.pendingTopUps.delete(botId)
      const recipient = this.db.getSmartTopUpSettings().recipient
      const balance = this.db.adjustMomoc(bot.userId, pending.cents / 100, 'tsl_top_up', `TSL 支付给 ${recipient} ${pending.amount} C`, botId)
      return { confirmed: true, amount: pending.amount, balance, sender: pending.sender }
    }
    if (action === 'runtime_version') {
      const runtime = readRuntimeUpdates(this.config.root, 'smart')
      return { version: runtime.version, release: runtime.latestRelease, releases: runtime.releases }
    }
    if (action === 'ominous_schedule_get') return this.db.getSmartBotAutomation(botId)
    if (action === 'ominous_schedule_complete') return this.db.completeSmartBotOminousBottle(botId)
    if (action === 'periodic_right_click_get') return this.db.getSmartBotAutomation(botId)
    if (action === 'periodic_right_click_complete') return this.db.completeSmartBotPeriodicRightClick(botId)
    if (action === 'task_get') return { task: this.db.getSmartBotTask(botId, payload.name) }
    if (action === 'task_list') return { tasks: this.db.listSmartBotTasks(botId) }
    if (action === 'schedule_status') return this.db.getSmartBotScheduleStatus(botId)
    if (action === 'volatile_schedules_reset') return this.db.resetSmartBotVolatileSchedules(botId)
    if (action === 'task_schedule_complete') return { task: this.db.completeSmartBotTaskSchedule(botId, payload.name) }
    const username = String(payload.username || '')
    const actor = this.db.getSmartAccess(bot.userId, username)
    const lock = this.db.getSmartBotLock(botId)

    if (action === 'access') return { ...actor, lock }
    if (actor.blacklisted) return { allowed: false, silent: true }

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
      return { allowed: true, settings: this.db.setSmartBotOminousBottle(botId, Boolean(payload.enabled)) }
    }

    if (action === 'periodic_right_click_set') {
      if (!actor.whitelisted || lock.adminLocked) return { allowed: false, silent: true }
      return {
        allowed: true,
        settings: this.db.setSmartBotPeriodicRightClick(botId, {
          enabled: Boolean(payload.enabled),
          x: payload.x,
          y: payload.y,
          z: payload.z,
          intervalTicks: payload.intervalTicks
        })
      }
    }

    if (action === 'task_schedule_set') {
      if (!actor.whitelisted || lock.adminLocked) return { allowed: false, silent: true }
      return { allowed: true, task: this.db.scheduleSmartBotTask(botId, payload.name, payload.intervalTicks, payload.args) }
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
    this.clearConnectionTimers(state)
    const reconnectDelayMs = Math.max(0, Number(this.config.reconnectDelayMs ?? 10000))
    const reconnectSeconds = Math.ceil(reconnectDelayMs / 1000)
    const version = state.activeVersion || '自动检测'
    this.db.updateBotRuntime(id, {
      runtimeState: 'reconnecting',
      lastError: `${reason}；${reconnectSeconds} 秒后继续使用 Minecraft ${version} 自动重连。`,
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
    this.db.updateBotRuntime(id, { desiredState: 'stopped', runtimeState: 'stopping', oauthJson: '' })
    const state = this.processes.get(id)
    if (!state) {
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
    if (bot.mode !== 'smart') throw new Error('只有智能 Bot 支持版本更新重启。')
    const state = this.processes.get(id)
    if (!state) throw new Error('机器人当前没有运行，请直接启动。')
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
    if (state.billingTimer) clearInterval(state.billingTimer)
    if (state.killTimer) clearTimeout(state.killTimer)
    state.billingTimer = null
    state.killTimer = null
  }

  handleExit (id, exitedState, code, signal) {
    if (this.processes.get(id) !== exitedState) return
    this.appendLog(id, exitedState.stopping || exitedState.restartPending ? 'info' : 'error', `Process exited: code=${code} signal=${signal || '-'}.`)
    this.clearStateTimers(exitedState)
    this.processes.delete(id)
    this.pendingTopUps.delete(id)
    const bot = this.db.getBot(id)
    if (!bot) {
      if (this.accountLocks.get(exitedState.accountId) === id) this.accountLocks.delete(exitedState.accountId)
      return
    }

    if (exitedState.restartPending && bot.desiredState === 'running') {
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
      const reconnectDelayMs = Math.max(0, Number(this.config.reconnectDelayMs ?? 10000))
      this.db.updateBotRuntime(id, { runtimeState: 'reconnecting', startedAt: null, oauthJson: '' })
      setTimeout(() => {
        const current = this.db.getBot(id)
        if (!current || current.desiredState !== 'running' || this.processes.has(id)) return
        try { this.launchAttempt(current, 0, { billingMode: exitedState.billingMode, priceMomoc: exitedState.priceMomoc }) } catch (error) { this.releaseOnceReservation(id, exitedState); if (this.accountLocks.get(exitedState.accountId) === id) this.accountLocks.delete(exitedState.accountId); this.setError(id, error) }
      }, reconnectDelayMs).unref()
      return
    }

    if (exitedState.profileAuthRecoveryPending && bot.desiredState === 'running') {
      setTimeout(() => {
        const current = this.db.getBot(id)
        if (!current || current.desiredState !== 'running' || this.processes.has(id)) return
        try { this.launchAttempt(current, exitedState.protocolIndex, { billingMode: exitedState.billingMode, priceMomoc: exitedState.priceMomoc }) } catch (error) { this.releaseOnceReservation(id, exitedState); if (this.accountLocks.get(exitedState.accountId) === id) this.accountLocks.delete(exitedState.accountId); this.setError(id, error) }
      }, 1000).unref()
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
      const reconnectDelayMs = Math.max(0, Number(this.config.reconnectDelayMs ?? 10000))
      const reconnectSeconds = Math.ceil(reconnectDelayMs / 1000)
      const reason = String(bot.lastError || `进程退出 code=${code} signal=${signal || ''}`).replace(/；?\d+ 秒后自动重连。?$/, '')
      this.db.updateBotRuntime(id, { runtimeState: 'reconnecting', lastError: `${reason}；${reconnectSeconds} 秒后自动重连。` })
      setTimeout(() => {
        const current = this.db.getBot(id)
        if (!current || current.desiredState !== 'running' || this.processes.has(id)) return
        try { this.launchAttempt(current, exitedState.protocolIndex, { billingMode: exitedState.billingMode, priceMomoc: exitedState.priceMomoc }) } catch (error) { if (this.accountLocks.get(exitedState.accountId) === id) this.accountLocks.delete(exitedState.accountId); this.setError(id, error) }
      }, reconnectDelayMs).unref()
      return
    }
    if (this.accountLocks.get(exitedState.accountId) === id) this.accountLocks.delete(exitedState.accountId)
  }

  async remove (id, actorUserId = null) {
    const bot = this.db.getBot(id)
    if (!bot) throw new Error('机器人不存在。')
    if (actorUserId && bot.userId !== actorUserId) throw new Error('无权操作这个机器人。')
    if (this.processes.has(id)) await this.stop(id, actorUserId)
    this.removeSchedule(id)
    this.db.deleteBot(id)
    this.logs.delete(id)
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
    for (const task of this.schedules.values()) task.destroy()
    this.schedules.clear()
    for (const [id] of this.processes) this.stop(id).catch(() => {})
  }
}

module.exports = BotManager
