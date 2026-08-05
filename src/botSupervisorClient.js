const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const SUPERVISOR_API_VERSION = 3

class BotSupervisorClient {
  constructor (db, config) {
    this.db = db
    this.config = config
    this.token = this.ensureToken()
  }

  ensureToken () {
    fs.mkdirSync(path.dirname(this.config.supervisorSecretFile), { recursive: true })
    try {
      const current = fs.readFileSync(this.config.supervisorSecretFile, 'utf8').trim()
      if (current.length >= 32) return current
    } catch {}
    const value = crypto.randomBytes(32).toString('hex')
    try {
      fs.writeFileSync(this.config.supervisorSecretFile, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const current = fs.readFileSync(this.config.supervisorSecretFile, 'utf8').trim()
      if (current.length >= 32) return current
      fs.writeFileSync(this.config.supervisorSecretFile, value, { encoding: 'utf8', mode: 0o600 })
    }
    try { fs.chmodSync(this.config.supervisorSecretFile, 0o600) } catch {}
    return value
  }

  request (pathname, input = null, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const payload = input == null ? null : Buffer.from(JSON.stringify(input))
      const request = http.request({
        host: '127.0.0.1',
        port: this.config.supervisorPort,
        path: pathname,
        method: payload ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {})
        }
      }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          let data = {}
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch {}
          if (response.statusCode >= 200 && response.statusCode < 300 && data.ok !== false) return resolve(data)
          const error = new Error(data.error || `Bot 守护进程请求失败 (${response.statusCode})。`)
          error.status = response.statusCode
          reject(error)
        })
      })
      request.setTimeout(timeoutMs, () => request.destroy(new Error('Bot 守护进程请求超时。')))
      request.on('error', reject)
      if (payload) request.write(payload)
      request.end()
    })
  }

  async health () {
    try {
      return await this.request('/health', null, 1000)
    } catch {
      return null
    }
  }

  async healthy () {
    const data = await this.health()
    return data?.service === 'bot-supervisor' && Number(data.apiVersion) === SUPERVISOR_API_VERSION
  }

  async replaceStaleSupervisor (health) {
    if (health?.service !== 'bot-supervisor') return true
    let rows
    try {
      rows = (await this.request('/command', { action: 'list' }, 3000)).result
    } catch (error) {
      console.warn(`[bot-supervisor] 无法确认旧守护进程是否空闲，保留现有进程以避免中断 Bot：${error.message || error}`)
      return false
    }
    const active = (Array.isArray(rows) ? rows : []).filter(bot => bot.desiredState === 'running' || !['stopped', 'completed'].includes(String(bot.runtimeState || '')))
    if (active.length) {
      console.warn(`[bot-supervisor] 当前是 API v${health.apiVersion || '未知'} 的旧守护进程，不支持原地热更新；仍有 ${active.length} 个 Bot 在运行，因此本次不会替换。这是启用热更新机制前最后一次需要维护窗口。`)
      return false
    }
    try {
      await this.request('/shutdown', {}, 1500)
    } catch {
      const pid = Number(health.pid)
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try { process.kill(pid, 'SIGTERM') } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    }

    const deadline = Date.now() + 7000
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
      if (!await this.health()) return true
    }
    throw new Error('旧版 Bot 守护进程未能正常退出。')
  }

  async ensureStarted () {
    const current = await this.health()
    if (current?.service === 'bot-supervisor' && Number(current.apiVersion) === SUPERVISOR_API_VERSION) return true
    if (!await this.replaceStaleSupervisor(current)) return true
    const entry = path.join(this.config.root, 'core-runtime', 'index.js')
    const child = spawn(process.execPath, [entry], {
      cwd: this.config.root,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, BOT_PLATFORM_SUPERVISOR_TOKEN: this.token }
    })
    child.unref()
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 150))
      if (await this.healthy()) return true
    }
    throw new Error(`Bot 守护进程未能在 127.0.0.1:${this.config.supervisorPort} 启动。`)
  }

  publicBot (bot) {
    if (!bot) return null
    let oauth = null
    try { oauth = bot.oauthJson ? JSON.parse(bot.oauthJson) : null } catch {}
    if (oauth?.expiresAt <= Date.now()) oauth = null
    const { templateProjectPath, templateVarsJson, oauthJson, billingRemainderMicros, ...safe } = bot
    const prices = this.db.getModePrices()
    return { ...safe, billingMode: bot.mode === 'signin' ? 'once' : 'hourly', priceMomoc: bot.mode === 'signin' ? prices.signinOncePrice : prices.smartHourlyPrice, allowScheduling: bot.mode === 'signin', scheduleEnabled: Boolean(bot.scheduleEnabled), oauth, logs: [] }
  }

  async command (action, payload = {}) {
    return (await this.request('/command', { action, ...payload })).result
  }

  list (userId = null) { return this.command('list', { userId }) }
  start (id, actorUserId = null) { return this.command('start', { id, actorUserId }) }
  stop (id, actorUserId = null) { return this.command('stop', { id, actorUserId }) }
  restart (id, actorUserId = null) { return this.command('restart', { id, actorUserId }) }
  remove (id, actorUserId = null) { return this.command('remove', { id, actorUserId }) }
  setSchedule (id, enabled, expression, actorUserId = null) { return this.command('set_schedule', { id, enabled, expression, actorUserId }) }
  syncSmartSettings (id) { return this.command('sync_smart_settings', { id }) }
  syncSmartTopUpSettings () { return this.command('sync_smart_settings', { id: '__all_top_up_settings__' }) }
  syncSmartAutomation (id) { return this.command('sync_smart_automation', { id }) }
  syncModules (id) { return this.command('sync_modules', { id }) }
}

module.exports = BotSupervisorClient
module.exports.SUPERVISOR_API_VERSION = SUPERVISOR_API_VERSION
