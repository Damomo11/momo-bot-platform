const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const Database = require('better-sqlite3')
const { hashPassword, verifyPassword, token, tokenHash } = require('./auth')

const MOMOC_SCALE = 1000000

function toMomocMicros (value, label = 'momoc') {
  const number = Number(value)
  const micros = Math.round(number * MOMOC_SCALE)
  if (!Number.isFinite(number) || Math.abs(number - micros / MOMOC_SCALE) > 1e-10) throw new Error(`${label} 最多支持 6 位小数。`)
  return micros
}

class PlatformDb {
  constructor (config) {
    this.config = config
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true })
    this.db = new Database(config.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.init()
  }

  init () {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        momoc INTEGER NOT NULL DEFAULT 0 CHECK (momoc >= 0),
        momoc_units INTEGER,
        reserved_momoc_units INTEGER NOT NULL DEFAULT 0,
        momoc_micros INTEGER,
        reserved_momoc_micros INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS bot_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        project_path TEXT NOT NULL DEFAULT '',
        billing_mode TEXT NOT NULL DEFAULT 'hourly',
        price_momoc INTEGER NOT NULL DEFAULT 60,
        allow_scheduling INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS microsoft_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        minecraft_name TEXT NOT NULL DEFAULT '',
        auth_state TEXT NOT NULL DEFAULT 'pending',
        oauth_json TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, email COLLATE NOCASE),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        account_id TEXT,
        template_id TEXT NOT NULL,
        label TEXT NOT NULL,
        microsoft_email TEXT NOT NULL,
        server_host TEXT NOT NULL,
        server_port INTEGER NOT NULL DEFAULT 25565,
        minecraft_version TEXT NOT NULL DEFAULT '',
        desired_state TEXT NOT NULL DEFAULT 'stopped',
        runtime_state TEXT NOT NULL DEFAULT 'stopped',
        minecraft_name TEXT NOT NULL DEFAULT '',
        template_vars_json TEXT NOT NULL DEFAULT '{}',
        last_error TEXT NOT NULL DEFAULT '',
        oauth_json TEXT NOT NULL DEFAULT '',
        started_at INTEGER,
        billed_minutes INTEGER NOT NULL DEFAULT 0,
        billing_remainder_micros INTEGER NOT NULL DEFAULT 0,
        schedule_enabled INTEGER NOT NULL DEFAULT 0,
        schedule_cron TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (account_id) REFERENCES microsoft_accounts(id) ON DELETE RESTRICT,
        FOREIGN KEY (template_id) REFERENCES bot_templates(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS momoc_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        delta INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        delta_units INTEGER,
        balance_after_units INTEGER,
        delta_micros INTEGER,
        balance_after_micros INTEGER,
        kind TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        bot_id TEXT,
        units INTEGER NOT NULL DEFAULT 1,
        started_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_accounts_user ON microsoft_accounts(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ledger_user ON momoc_ledger(user_id, id DESC);
    `)
    this.ensureColumn('bot_templates', 'project_path', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('bot_templates', 'billing_mode', "TEXT NOT NULL DEFAULT 'hourly'")
    this.ensureColumn('bot_templates', 'price_momoc', 'INTEGER NOT NULL DEFAULT 60')
    this.ensureColumn('bot_templates', 'allow_scheduling', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('bots', 'account_id', 'TEXT')
    this.ensureColumn('bots', 'template_vars_json', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('users', 'momoc_units', 'INTEGER')
    this.ensureColumn('users', 'reserved_momoc_units', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('users', 'momoc_micros', 'INTEGER')
    this.ensureColumn('users', 'reserved_momoc_micros', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('bots', 'billing_remainder_micros', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('bots', 'schedule_enabled', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('bots', 'schedule_cron', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('momoc_ledger', 'units', 'INTEGER NOT NULL DEFAULT 1')
    this.ensureColumn('momoc_ledger', 'started_at', 'TEXT')
    this.ensureColumn('momoc_ledger', 'delta_units', 'INTEGER')
    this.ensureColumn('momoc_ledger', 'balance_after_units', 'INTEGER')
    this.ensureColumn('momoc_ledger', 'delta_micros', 'INTEGER')
    this.ensureColumn('momoc_ledger', 'balance_after_micros', 'INTEGER')
    this.db.prepare('UPDATE users SET momoc_units = CAST(ROUND(momoc * 60) AS INTEGER) WHERE momoc_units IS NULL').run()
    this.db.prepare('UPDATE momoc_ledger SET delta_units = CAST(ROUND(delta * 60) AS INTEGER) WHERE delta_units IS NULL').run()
    this.db.prepare('UPDATE momoc_ledger SET balance_after_units = CAST(ROUND(balance_after * 60) AS INTEGER) WHERE balance_after_units IS NULL').run()
    this.db.prepare('UPDATE users SET momoc_micros = CAST(ROUND(momoc * 1000000) AS INTEGER) WHERE momoc_micros IS NULL').run()
    this.db.prepare('UPDATE momoc_ledger SET delta_micros = CAST(ROUND(delta * 1000000) AS INTEGER) WHERE delta_micros IS NULL').run()
    this.db.prepare('UPDATE momoc_ledger SET balance_after_micros = CAST(ROUND(balance_after * 1000000) AS INTEGER) WHERE balance_after_micros IS NULL').run()
    this.db.prepare('UPDATE users SET reserved_momoc_units = 0').run()
    this.db.prepare('UPDATE users SET reserved_momoc_micros = 0').run()
    this.seedAdmin()
    this.seedIdleTemplate()
    this.migrateBotAccounts()
    this.db.prepare("UPDATE bots SET runtime_state = 'stopped', oauth_json = '', started_at = NULL WHERE runtime_state <> 'stopped'").run()
  }

  ensureColumn (table, column, definition) {
    const exists = this.db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)
    if (!exists) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  migrateBotAccounts () {
    const rows = this.db.prepare('SELECT id, user_id AS userId, microsoft_email AS email, minecraft_name AS minecraftName, account_id AS accountId FROM bots').all()
    for (const bot of rows) {
      if (bot.accountId) continue
      let account = this.db.prepare('SELECT * FROM microsoft_accounts WHERE user_id = ? AND email = ? COLLATE NOCASE').get(bot.userId, bot.email)
      if (!account) {
        const id = crypto.randomUUID()
        const source = path.join(this.config.authCacheRoot || '', bot.id)
        const authorized = Boolean(bot.minecraftName && source && fs.existsSync(source))
        this.db.prepare('INSERT INTO microsoft_accounts (id, user_id, email, minecraft_name, auth_state) VALUES (?, ?, ?, ?, ?)').run(id, bot.userId, bot.email, bot.minecraftName || '', authorized ? 'authorized' : 'pending')
        account = this.db.prepare('SELECT * FROM microsoft_accounts WHERE id = ?').get(id)
        if (authorized && this.config.authCacheRoot) {
          const target = path.join(this.config.authCacheRoot, 'accounts', id)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          if (!fs.existsSync(target)) fs.cpSync(source, target, { recursive: true })
        }
      }
      this.db.prepare('UPDATE bots SET account_id = ? WHERE id = ?').run(account.id, bot.id)
    }
  }

  seedAdmin () {
    const exists = this.db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()
    if (exists) return
    this.createUser(this.config.bootstrapAdminUsername, this.config.bootstrapAdminPassword, 'admin')
  }

  seedIdleTemplate () {
    const id = 'idle-login'
    const projectPath = path.join(this.config.root || path.resolve(__dirname, '..'), 'templates', 'idle-login')
    if (this.db.prepare('SELECT 1 FROM bot_templates WHERE id = ?').get(id)) {
      this.db.prepare('UPDATE bot_templates SET project_path = ? WHERE id = ?').run(projectPath, id)
      return
    }
    this.db.prepare(`INSERT INTO bot_templates (id, name, description, source, project_path) VALUES (?, ?, ?, ?, ?)`).run(
      id,
      '仅登录挂机',
      '登录服务器后保持在线，不执行其他动作。',
      '',
      projectPath
    )
  }

  createUser (username, password, role = 'user') {
    const name = String(username || '').trim()
    if (!/^[A-Za-z0-9_\-]{3,32}$/.test(name)) throw new Error('用户名需为 3-32 位字母、数字、下划线或连字符。')
    if (String(password || '').length < 8) throw new Error('密码至少 8 位。')
    const id = crypto.randomUUID()
    this.db.prepare('INSERT INTO users (id, username, password_hash, role, momoc_units, momoc_micros) VALUES (?, ?, ?, ?, 0, 0)').run(id, name, hashPassword(password), role)
    return this.getUser(id)
  }

  authenticate (username, password) {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').trim())
    return row && verifyPassword(password, row.password_hash) ? this.publicUser(row) : null
  }

  publicUser (row) {
    if (!row) return null
    const momoc = Number(row.momoc_micros || 0) / MOMOC_SCALE
    const reservedMomoc = Number(row.reserved_momoc_micros || 0) / MOMOC_SCALE
    return { id: row.id, username: row.username, role: row.role, momoc, reservedMomoc, availableMomoc: momoc - reservedMomoc, createdAt: row.created_at }
  }

  getUser (id) {
    return this.publicUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id))
  }

  listUsers () {
    return this.db.prepare('SELECT * FROM users ORDER BY role = \'admin\' DESC, username COLLATE NOCASE').all().map(row => this.publicUser(row))
  }

  publicMicrosoftAccount (row) {
    if (!row) return null
    let oauth = null
    try { oauth = row.oauth_json ? JSON.parse(row.oauth_json) : null } catch {}
    if (oauth?.expiresAt <= Date.now()) oauth = null
    return {
      id: row.id,
      userId: row.user_id,
      email: row.email,
      minecraftName: row.minecraft_name,
      authState: row.auth_state,
      lastError: row.last_error,
      oauth,
      botCount: Number(row.bot_count || 0),
      createdAt: row.created_at
    }
  }

  createMicrosoftAccount (userId, email) {
    const value = String(email || '').trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Microsoft 邮箱格式不正确。')
    const id = crypto.randomUUID()
    this.db.prepare('INSERT INTO microsoft_accounts (id, user_id, email) VALUES (?, ?, ?)').run(id, userId, value)
    return this.getMicrosoftAccount(id)
  }

  getMicrosoftAccount (id) {
    const row = this.db.prepare('SELECT a.*, (SELECT COUNT(*) FROM bots b WHERE b.account_id = a.id) AS bot_count FROM microsoft_accounts a WHERE a.id = ?').get(id)
    return this.publicMicrosoftAccount(row)
  }

  listMicrosoftAccounts (userId = null) {
    const rows = userId
      ? this.db.prepare('SELECT a.*, (SELECT COUNT(*) FROM bots b WHERE b.account_id = a.id) AS bot_count FROM microsoft_accounts a WHERE a.user_id = ? ORDER BY a.created_at DESC').all(userId)
      : this.db.prepare('SELECT a.*, (SELECT COUNT(*) FROM bots b WHERE b.account_id = a.id) AS bot_count FROM microsoft_accounts a ORDER BY a.created_at DESC').all()
    return rows.map(row => this.publicMicrosoftAccount(row))
  }

  updateMicrosoftAccountAuth (id, fields) {
    const allowed = { minecraftName: 'minecraft_name', authState: 'auth_state', lastError: 'last_error', oauthJson: 'oauth_json' }
    const pairs = []
    const values = []
    for (const [key, column] of Object.entries(allowed)) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue
      pairs.push(`${column} = ?`)
      values.push(fields[key])
    }
    if (pairs.length) this.db.prepare(`UPDATE microsoft_accounts SET ${pairs.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, id)
    return this.getMicrosoftAccount(id)
  }

  deleteMicrosoftAccount (id) {
    const used = this.db.prepare('SELECT COUNT(*) AS count FROM bots WHERE account_id = ?').get(id).count
    if (used) throw new Error('这个微软账号仍被机器人使用，不能删除。')
    return this.db.prepare('DELETE FROM microsoft_accounts WHERE id = ?').run(id).changes
  }

  createSession (userId) {
    const raw = token()
    const expiresAt = Date.now() + this.config.sessionDays * 86400000
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(raw), userId, expiresAt)
    return { token: raw, expiresAt }
  }

  getSessionUser (raw) {
    if (!raw) return null
    const row = this.db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash(raw), Date.now())
    return this.publicUser(row)
  }

  deleteSession (raw) {
    if (raw) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(raw))
  }

  adjustMomoc (userId, delta, kind, note = '', botId = null) {
    const amountMicros = toMomocMicros(delta)
    if (amountMicros === 0) throw new Error('momoc 调整数量无效。')
    return this.db.transaction(() => {
      const user = this.db.prepare('SELECT momoc_micros AS momocMicros, reserved_momoc_micros AS reservedMicros FROM users WHERE id = ?').get(userId)
      if (!user) throw new Error('用户不存在。')
      const nextMicros = Number(user.momocMicros || 0) + amountMicros
      if (nextMicros < Number(user.reservedMicros || 0)) throw new Error('可用 momoc 余额不足。')
      const normalizedAmount = amountMicros / MOMOC_SCALE
      const next = nextMicros / MOMOC_SCALE
      this.db.prepare('UPDATE users SET momoc = ?, momoc_units = ?, momoc_micros = ? WHERE id = ?').run(next, Math.round(next * 60), nextMicros, userId)
      this.db.prepare('INSERT INTO momoc_ledger (user_id, delta, balance_after, delta_units, balance_after_units, delta_micros, balance_after_micros, kind, note, bot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(userId, normalizedAmount, next, Math.round(normalizedAmount * 60), Math.round(next * 60), amountMicros, nextMicros, kind, note, botId)
      return next
    })()
  }

  chargeHourlyMinute (botId, hourlyRate) {
    const bot = this.getBot(botId)
    if (!bot) return { ok: false, reason: 'missing' }
    try {
      const rate = Number(hourlyRate)
      if (!Number.isFinite(rate) || rate < 0) throw new Error('每小时价格无效。')
      const rateMicros = toMomocMicros(rate, '每小时价格')
      const result = this.db.transaction(() => {
        const user = this.db.prepare('SELECT momoc_micros AS momocMicros, reserved_momoc_micros AS reservedMicros FROM users WHERE id = ?').get(bot.userId)
        if (!user) throw new Error('用户不存在。')
        const accruedMicros = Number(bot.billingRemainderMicros || 0) + rateMicros
        const costMicros = Math.floor(accruedMicros / 60)
        const remainderMicros = accruedMicros % 60
        const nextMicros = Number(user.momocMicros || 0) - costMicros
        if (nextMicros < Number(user.reservedMicros || 0)) throw new Error('可用 momoc 余额不足。')
        const cost = costMicros / MOMOC_SCALE
        const next = nextMicros / MOMOC_SCALE
        if (costMicros > 0) this.db.prepare('UPDATE users SET momoc = ?, momoc_units = ?, momoc_micros = ? WHERE id = ?').run(next, Math.round(next * 60), nextMicros, bot.userId)

        const latest = this.db.prepare("SELECT id, units, delta_micros AS deltaMicros, created_at AS createdAt FROM momoc_ledger WHERE user_id = ? AND bot_id = ? AND kind = 'bot_hourly' ORDER BY id DESC LIMIT 1").get(bot.userId, bot.id)
        const latestAt = latest?.createdAt ? Date.parse(String(latest.createdAt).replace(' ', 'T') + 'Z') : 0
        if (latest && Date.now() - latestAt <= 150000) {
          const minutes = Number(latest.units || 1) + 1
          const deltaMicros = Number(latest.deltaMicros || 0) - costMicros
          this.db.prepare('UPDATE momoc_ledger SET delta = ?, balance_after = ?, delta_units = ?, balance_after_units = ?, delta_micros = ?, balance_after_micros = ?, units = ?, note = ?, started_at = COALESCE(started_at, created_at), created_at = CURRENT_TIMESTAMP WHERE id = ?').run(deltaMicros / MOMOC_SCALE, next, Math.round(deltaMicros / MOMOC_SCALE * 60), Math.round(next * 60), deltaMicros, nextMicros, minutes, `${bot.label} 运行 ${minutes} 分钟`, latest.id)
        } else {
          this.db.prepare("INSERT INTO momoc_ledger (user_id, delta, balance_after, delta_units, balance_after_units, delta_micros, balance_after_micros, kind, note, bot_id, units, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'bot_hourly', ?, ?, 1, CURRENT_TIMESTAMP)").run(bot.userId, -cost, next, Math.round(-cost * 60), Math.round(next * 60), -costMicros, nextMicros, `${bot.label} 运行 1 分钟`, bot.id)
        }
        this.db.prepare('UPDATE bots SET billed_minutes = billed_minutes + 1, billing_remainder_micros = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(remainderMicros, bot.id)
        return { balance: next, charged: cost }
      })()
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, reason: error.message }
    }
  }

  reserveOnce (botId, price) {
    const bot = this.getBot(botId)
    if (!bot) return { ok: false, reason: 'missing' }
    try {
      const number = Number(price)
      if (!Number.isFinite(number) || number < 0) throw new Error('按次价格无效。')
      const costMicros = toMomocMicros(number, '按次价格')
      const availableMomoc = this.db.transaction(() => {
        const user = this.db.prepare('SELECT momoc_micros AS momocMicros, reserved_momoc_micros AS reservedMicros FROM users WHERE id = ?').get(bot.userId)
        if (!user) throw new Error('用户不存在。')
        const availableMicros = Number(user.momocMicros || 0) - Number(user.reservedMicros || 0)
        if (availableMicros < costMicros) throw new Error('可用 momoc 余额不足。')
        this.db.prepare('UPDATE users SET reserved_momoc_micros = reserved_momoc_micros + ?, reserved_momoc_units = reserved_momoc_units + ? WHERE id = ?').run(costMicros, Math.round(number * 60), bot.userId)
        return (availableMicros - costMicros) / MOMOC_SCALE
      })()
      return { ok: true, availableMomoc, reserved: costMicros / MOMOC_SCALE }
    } catch (error) {
      return { ok: false, reason: error.message }
    }
  }

  releaseOnce (botId, price) {
    const bot = this.getBot(botId)
    if (!bot) return false
    const number = Number(price)
    if (!Number.isFinite(number) || number < 0) return false
    const costMicros = toMomocMicros(number, '按次价格')
    this.db.prepare('UPDATE users SET reserved_momoc_micros = MAX(0, reserved_momoc_micros - ?), reserved_momoc_units = MAX(0, reserved_momoc_units - ?) WHERE id = ?').run(costMicros, Math.round(number * 60), bot.userId)
    return true
  }

  chargeOnce (botId, price, detail = '') {
    const bot = this.getBot(botId)
    if (!bot) return { ok: false, reason: 'missing' }
    try {
      const cost = Number(price)
      if (!Number.isFinite(cost) || cost < 0) throw new Error('按次价格无效。')
      const costMicros = toMomocMicros(cost, '按次价格')
      const balance = this.db.transaction(() => {
        const user = this.db.prepare('SELECT momoc_micros AS momocMicros, reserved_momoc_micros AS reservedMicros FROM users WHERE id = ?').get(bot.userId)
        if (!user) throw new Error('用户不存在。')
        if (Number(user.reservedMicros || 0) < costMicros) throw new Error('按次费用未预留。')
        const nextMicros = Number(user.momocMicros || 0) - costMicros
        if (nextMicros < 0) throw new Error('momoc 余额不足。')
        const next = nextMicros / MOMOC_SCALE
        this.db.prepare('UPDATE users SET momoc = ?, momoc_units = ?, momoc_micros = ?, reserved_momoc_units = MAX(0, reserved_momoc_units - ?), reserved_momoc_micros = MAX(0, reserved_momoc_micros - ?) WHERE id = ?').run(next, Math.round(next * 60), nextMicros, Math.round(cost * 60), costMicros, bot.userId)
        const suffix = String(detail || '').trim().slice(0, 200)
        const note = `${bot.label} 执行成功${suffix ? `：${suffix}` : ''}`
        this.db.prepare("INSERT INTO momoc_ledger (user_id, delta, balance_after, delta_units, balance_after_units, delta_micros, balance_after_micros, kind, note, bot_id, units, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'bot_once', ?, ?, 1, CURRENT_TIMESTAMP)").run(bot.userId, -cost, next, Math.round(-cost * 60), Math.round(next * 60), -costMicros, nextMicros, note, bot.id)
        return next
      })()
      return { ok: true, balance, charged: cost }
    } catch (error) {
      return { ok: false, reason: error.message }
    }
  }

  listLedger (userId, limit = 100) {
    const rawLimit = Math.min(5000, Math.max(limit * 20, limit))
    const rows = this.db.prepare(`SELECT l.id, COALESCE(l.delta_micros, CAST(ROUND(l.delta * 1000000) AS INTEGER)) AS deltaMicros, COALESCE(l.balance_after_micros, CAST(ROUND(l.balance_after * 1000000) AS INTEGER)) AS balanceAfterMicros, l.kind, l.note, l.bot_id AS botId, l.units, COALESCE(l.started_at, l.created_at) AS startedAt, l.created_at AS createdAt, b.label AS botLabel FROM momoc_ledger l LEFT JOIN bots b ON b.id = l.bot_id WHERE l.user_id = ? ORDER BY l.id DESC LIMIT ?`).all(userId, rawLimit).map(row => {
      const { deltaMicros, balanceAfterMicros, ...safe } = row
      return { ...safe, delta: Number(deltaMicros || 0) / MOMOC_SCALE, balanceAfter: Number(balanceAfterMicros || 0) / MOMOC_SCALE }
    })
    const result = []
    const openSessions = new Map()

    for (const row of rows) {
      if (row.kind !== 'bot_minute' && row.kind !== 'bot_hourly') {
        result.push(row)
        continue
      }
      const label = row.botLabel || String(row.note || '').replace(/\s*运行\s*\d+\s*分钟.*$/, '') || '机器人'
      const key = row.botId || `deleted:${label}`
      const previous = openSessions.get(key)
      const previousStart = previous ? Date.parse(String(previous.startedAt).replace(' ', 'T') + 'Z') : 0
      const rowEnd = Date.parse(String(row.createdAt).replace(' ', 'T') + 'Z')
      if (previous && previousStart - rowEnd <= 150000) {
        previous.delta += Number(row.delta)
        previous.minutes += Number(row.units || 1)
        previous.startedAt = row.startedAt
        previous.note = `${label} 运行 ${previous.minutes} 分钟`
        continue
      }
      const session = {
        ...row,
        kind: 'bot_usage',
        minutes: Number(row.units || 1),
        note: `${label} 运行 ${Number(row.units || 1)} 分钟`
      }
      result.push(session)
      openSessions.set(key, session)
    }
    return result.slice(0, limit)
  }

  listTemplates (includeDisabled = false) {
    return this.db.prepare(`SELECT id, name, description, project_path AS projectPath, billing_mode AS billingMode, price_momoc AS priceMomoc, allow_scheduling AS allowScheduling, enabled, created_at AS createdAt, updated_at AS updatedAt FROM bot_templates ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY name COLLATE NOCASE`).all().map(row => ({ ...row, enabled: Boolean(row.enabled), allowScheduling: Boolean(row.allowScheduling), priceMomoc: Number(row.priceMomoc || 0) }))
  }

  saveTemplate ({ id, name, description, projectPath, billingMode = 'hourly', priceMomoc = 60, allowScheduling = false, enabled = true }) {
    const templateId = String(id || crypto.randomUUID())
    const title = String(name || '').trim()
    if (!title) throw new Error('模板名称不能为空。')
    const folder = String(projectPath || '').trim()
    if (!folder) throw new Error('模板项目目录不能为空。')
    const mode = billingMode === 'once' ? 'once' : 'hourly'
    const rawPrice = Number(priceMomoc)
    if (!Number.isFinite(rawPrice) || rawPrice < 0 || rawPrice > 1000000000) throw new Error('模板价格必须在 0-1000000000 之间。')
    const price = toMomocMicros(rawPrice, '模板价格') / MOMOC_SCALE
    const scheduling = mode === 'once' && allowScheduling ? 1 : 0
    this.db.prepare(`INSERT INTO bot_templates (id, name, description, source, project_path, billing_mode, price_momoc, allow_scheduling, enabled, updated_at) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, project_path=excluded.project_path, billing_mode=excluded.billing_mode, price_momoc=excluded.price_momoc, allow_scheduling=excluded.allow_scheduling, enabled=excluded.enabled, updated_at=CURRENT_TIMESTAMP`).run(templateId, title, String(description || ''), folder, mode, price, scheduling, enabled ? 1 : 0)
    if (!scheduling) this.db.prepare("UPDATE bots SET schedule_enabled = 0, schedule_cron = '', updated_at = CURRENT_TIMESTAMP WHERE template_id = ?").run(templateId)
    return this.db.prepare('SELECT id, name, description, project_path AS projectPath, billing_mode AS billingMode, price_momoc AS priceMomoc, allow_scheduling AS allowScheduling, enabled FROM bot_templates WHERE id = ?').get(templateId)
  }

  deleteTemplate (id) {
    const used = this.db.prepare('SELECT COUNT(*) AS count FROM bots WHERE template_id = ?').get(id).count
    if (used) throw new Error('这个模板仍被机器人使用，不能删除。')
    return this.db.prepare('DELETE FROM bot_templates WHERE id = ?').run(id).changes
  }

  createBot (userId, input) {
    const id = crypto.randomUUID()
    const template = this.db.prepare('SELECT 1 FROM bot_templates WHERE id = ? AND enabled = 1').get(input.templateId)
    if (!template) throw new Error('机器人模板不可用。')
    let account = input.accountId ? this.db.prepare('SELECT * FROM microsoft_accounts WHERE id = ? AND user_id = ?').get(input.accountId, userId) : null
    if (!account && input.microsoftEmail) {
      account = this.db.prepare('SELECT * FROM microsoft_accounts WHERE user_id = ? AND email = ? COLLATE NOCASE').get(userId, input.microsoftEmail)
      if (!account) {
        account = this.createMicrosoftAccount(userId, input.microsoftEmail)
        account = this.db.prepare('SELECT * FROM microsoft_accounts WHERE id = ?').get(account.id)
      }
    }
    if (!account) throw new Error('请选择微软账号。')
    const port = Number.parseInt(input.serverPort, 10) || 25565
    this.db.prepare(`INSERT INTO bots (id, user_id, account_id, template_id, label, microsoft_email, server_host, server_port, minecraft_version, template_vars_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, account.id, input.templateId, String(input.label || 'Minecraft Bot').trim(), account.email, String(input.serverHost || '').trim(), port, String(input.minecraftVersion || '').trim(), JSON.stringify(input.templateVariables || {}))
    return this.getBot(id)
  }

  getBot (id) {
    return this.db.prepare(`SELECT b.id, b.user_id AS userId, u.username AS ownerUsername, b.account_id AS accountId, a.email AS microsoftEmail, a.minecraft_name AS accountMinecraftName, a.auth_state AS accountAuthState, b.template_id AS templateId, t.name AS templateName, t.project_path AS templateProjectPath, t.billing_mode AS billingMode, t.price_momoc AS priceMomoc, t.allow_scheduling AS allowScheduling, b.label, b.server_host AS serverHost, b.server_port AS serverPort, b.minecraft_version AS minecraftVersion, b.desired_state AS desiredState, b.runtime_state AS runtimeState, b.minecraft_name AS minecraftName, b.template_vars_json AS templateVarsJson, b.last_error AS lastError, b.oauth_json AS oauthJson, b.started_at AS startedAt, b.billed_minutes AS billedMinutes, b.billing_remainder_micros AS billingRemainderMicros, b.schedule_enabled AS scheduleEnabled, b.schedule_cron AS scheduleCron, b.created_at AS createdAt FROM bots b JOIN users u ON u.id=b.user_id JOIN bot_templates t ON t.id=b.template_id JOIN microsoft_accounts a ON a.id=b.account_id WHERE b.id=?`).get(id) || null
  }

  listBots (userId = null) {
    const rows = userId ? this.db.prepare('SELECT id FROM bots WHERE user_id = ? ORDER BY created_at DESC').all(userId) : this.db.prepare('SELECT id FROM bots ORDER BY created_at DESC').all()
    return rows.map(row => this.getBot(row.id))
  }

  updateBotRuntime (id, fields) {
    const allowed = { desiredState: 'desired_state', runtimeState: 'runtime_state', minecraftName: 'minecraft_name', lastError: 'last_error', oauthJson: 'oauth_json', startedAt: 'started_at' }
    const pairs = []
    const values = []
    for (const [key, column] of Object.entries(allowed)) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue
      pairs.push(`${column} = ?`)
      values.push(fields[key])
    }
    if (!pairs.length) return
    this.db.prepare(`UPDATE bots SET ${pairs.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...values, id)
  }

  updateBotVariables (id, values) {
    this.db.prepare('UPDATE bots SET template_vars_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(values || {}), id)
    return this.getBot(id)
  }

  updateBotSchedule (id, enabled, cron) {
    this.db.prepare('UPDATE bots SET schedule_enabled = ?, schedule_cron = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(enabled ? 1 : 0, enabled ? String(cron || '') : '', id)
    return this.getBot(id)
  }

  adminOverview () {
    const accounts = this.db.prepare(`
      SELECT a.id, a.user_id AS userId, u.username, a.email,
        a.minecraft_name AS minecraftName, a.auth_state AS authState,
        a.last_error AS lastError, a.created_at AS createdAt,
        COUNT(DISTINCT b.id) AS botCount,
        GROUP_CONCAT(DISTINCT t.name) AS templateNames
      FROM microsoft_accounts a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN bots b ON b.account_id = a.id
      LEFT JOIN bot_templates t ON t.id = b.template_id
      GROUP BY a.id
      ORDER BY a.created_at DESC
    `).all().map(row => ({
      ...row,
      botCount: Number(row.botCount || 0),
      templateNames: row.templateNames ? row.templateNames.split(',') : []
    }))

    const consumption = this.db.prepare(`
      SELECT u.id AS userId, u.username, u.role,
        COALESCE(u.momoc_micros, CAST(ROUND(u.momoc * ${MOMOC_SCALE}) AS INTEGER), 0) AS balanceMicros,
        COALESCE(u.reserved_momoc_micros, 0) AS reservedMicros,
        COALESCE(SUM(CASE WHEN l.kind IN ('bot_hourly', 'bot_minute') AND COALESCE(l.delta_micros, CAST(ROUND(l.delta * ${MOMOC_SCALE}) AS INTEGER)) < 0 THEN -COALESCE(l.delta_micros, CAST(ROUND(l.delta * ${MOMOC_SCALE}) AS INTEGER)) ELSE 0 END), 0) AS hourlyMicros,
        COALESCE(SUM(CASE WHEN l.kind = 'bot_once' AND COALESCE(l.delta_micros, CAST(ROUND(l.delta * ${MOMOC_SCALE}) AS INTEGER)) < 0 THEN -COALESCE(l.delta_micros, CAST(ROUND(l.delta * ${MOMOC_SCALE}) AS INTEGER)) ELSE 0 END), 0) AS onceMicros,
        COALESCE((SELECT SUM(b.billed_minutes) FROM bots b WHERE b.user_id = u.id), 0) AS billedMinutes
      FROM users u
      LEFT JOIN momoc_ledger l ON l.user_id = u.id
      GROUP BY u.id
      ORDER BY (hourlyMicros + onceMicros) DESC, u.username COLLATE NOCASE
    `).all().map(row => ({
      userId: row.userId,
      username: row.username,
      role: row.role,
      balance: Number(row.balanceMicros || 0) / MOMOC_SCALE,
      reserved: Number(row.reservedMicros || 0) / MOMOC_SCALE,
      hourlySpent: Number(row.hourlyMicros || 0) / MOMOC_SCALE,
      onceSpent: Number(row.onceMicros || 0) / MOMOC_SCALE,
      totalSpent: (Number(row.hourlyMicros || 0) + Number(row.onceMicros || 0)) / MOMOC_SCALE,
      billedMinutes: Number(row.billedMinutes || 0)
    }))

    const bots = this.listBots()
    return {
      stats: {
        users: consumption.length,
        accounts: accounts.length,
        authorizedAccounts: accounts.filter(row => row.authState === 'authorized').length,
        bots: bots.length,
        runningBots: bots.filter(row => row.runtimeState !== 'stopped').length,
        totalSpent: consumption.reduce((sum, row) => sum + row.totalSpent, 0)
      },
      accounts,
      bots,
      consumption
    }
  }

  deleteBot (id) {
    return this.db.prepare('DELETE FROM bots WHERE id = ?').run(id).changes
  }

  close () { this.db.close() }
}

module.exports = PlatformDb
