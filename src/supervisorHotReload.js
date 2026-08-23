const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function upgradeObjectState (target, NextConstructor, args = []) {
  const defaults = new NextConstructor(...args)
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof target[key] === 'undefined') target[key] = value
  }
  Object.setPrototypeOf(target, NextConstructor.prototype)
  return target
}

class SupervisorHotReloader {
  constructor (options) {
    this.root = options.root
    this.config = options.config
    this.db = options.db
    this.bots = options.bots
    this.logger = options.logger || console
    this.intervalMs = Number(options.intervalMs || 2000)
    this.srcRoot = path.join(this.root, 'src')
    this.timer = null
    this.revision = this.fingerprint()
    this.pendingRevision = ''
    this.reloading = false
  }

  sourceFiles () {
    return fs.readdirSync(this.srcRoot, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
      .map(entry => path.join(this.srcRoot, entry.name))
      .sort()
  }

  fingerprint () {
    const hash = crypto.createHash('sha256')
    for (const file of this.sourceFiles()) {
      hash.update(path.basename(file))
      hash.update(fs.readFileSync(file))
    }
    return hash.digest('hex').slice(0, 16)
  }

  clearSourceModuleCache () {
    const prefix = path.resolve(this.srcRoot) + path.sep
    const self = require.resolve('./supervisorHotReload')
    for (const file of Object.keys(require.cache)) {
      if (file !== self && path.resolve(file).startsWith(prefix)) delete require.cache[file]
    }
  }

  reloadIfChanged () {
    if (this.reloading) return false
    const nextRevision = this.fingerprint()
    if (nextRevision === this.revision) {
      this.pendingRevision = ''
      return false
    }
    if (nextRevision !== this.pendingRevision) {
      this.pendingRevision = nextRevision
      return false
    }
    this.reloading = true
    const previousDbPrototype = Object.getPrototypeOf(this.db)
    const previousBotPrototype = Object.getPrototypeOf(this.bots)
    try {
      this.clearSourceModuleCache()
      const NextPlatformDb = require('./db')
      const NextBotManager = require('./botManager')
      Object.setPrototypeOf(this.db, NextPlatformDb.prototype)
      this.db.init()
      upgradeObjectState(this.bots, NextBotManager, [this.db, this.config])
      this.bots.startDailyAutomationScheduler?.()
      const recovered = this.bots.recoverDisconnectedRuntimes?.() || 0
      this.revision = nextRevision
      this.pendingRevision = ''
      this.logger.log?.(`[bot-supervisor] 业务代码已热更新至 ${nextRevision}，运行中的 Bot 未中断。`)
      if (recovered) this.logger.log?.(`[bot-supervisor] 已回收 ${recovered} 个连接结束但进程未退出的 Bot，等待自动重连。`)
      return true
    } catch (error) {
      Object.setPrototypeOf(this.db, previousDbPrototype)
      Object.setPrototypeOf(this.bots, previousBotPrototype)
      this.logger.error?.('[bot-supervisor] 业务代码热更新失败，将保留当前版本。', error)
      return false
    } finally {
      this.reloading = false
    }
  }

  start () {
    if (this.timer) return
    this.timer = setInterval(() => {
      try {
        this.reloadIfChanged()
      } catch (error) {
        this.logger.error?.('[bot-supervisor] 暂时无法检查业务代码更新，将在下一轮重试。', error)
      }
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

module.exports = { SupervisorHotReloader, upgradeObjectState }
