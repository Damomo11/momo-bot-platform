const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const Database = require('better-sqlite3')
const { hashPassword, verifyPassword, token, tokenHash } = require('./auth')
const { parseModuleSource } = require('./moduleDefinition')

const MOMOC_SCALE = 1000000

function toMomocMicros (value, label = 'momoc') {
  const number = Number(value)
  const micros = Math.round(number * MOMOC_SCALE)
  if (!Number.isFinite(number) || Math.abs(number - micros / MOMOC_SCALE) > 1e-10) throw new Error(`${label} 最多支持 6 位小数。`)
  return micros
}

function normalizeSmartPlayerName (value) {
  const name = String(value || '').trim().replace(/^#/, '')
  if (!name || name.length > 32 || /[\s\u0000-\u001f\u007f]/.test(name)) throw new Error('玩家名必须为 1-32 个非空白字符。')
  return name
}

class PlatformDb {
  constructor (config) {
    this.config = config
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true })
    this.db = new Database(config.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
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
        auth_source TEXT NOT NULL DEFAULT 'local',
        external_id TEXT,
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
        mode TEXT NOT NULL DEFAULT 'smart',
        mode_vars_json TEXT NOT NULL DEFAULT '{}',
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
        FOREIGN KEY (account_id) REFERENCES microsoft_accounts(id) ON DELETE RESTRICT
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
        module_id TEXT,
        units INTEGER NOT NULL DEFAULT 1,
        started_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS smart_permissions (
        owner_user_id TEXT NOT NULL,
        player_name TEXT NOT NULL COLLATE NOCASE,
        role TEXT NOT NULL CHECK (role IN ('whitelist', 'blacklist', 'admin')),
        expires_at INTEGER,
        created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_user_id, player_name, role),
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS smart_bot_locks (
        bot_id TEXT PRIMARY KEY,
        locked INTEGER NOT NULL DEFAULT 0,
        admin_locked INTEGER NOT NULL DEFAULT 0,
        locked_by TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS smart_bot_automation (
        bot_id TEXT PRIMARY KEY,
        ominous_bottle_enabled INTEGER NOT NULL DEFAULT 0,
        ominous_bottle_last_used_at INTEGER,
        ominous_bottle_next_due_at INTEGER,
        periodic_right_click_enabled INTEGER NOT NULL DEFAULT 0,
        periodic_right_click_x INTEGER,
        periodic_right_click_y INTEGER,
        periodic_right_click_z INTEGER,
        periodic_right_click_interval_ticks INTEGER NOT NULL DEFAULT 20,
        periodic_right_click_last_run_at INTEGER,
        periodic_right_click_next_due_at INTEGER,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS smart_bot_settings (
        bot_id TEXT PRIMARY KEY,
        command_prefix TEXT NOT NULL DEFAULT '',
        message_overrides_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS smart_bot_tasks (
        bot_id TEXT NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE,
        steps_json TEXT NOT NULL DEFAULT '[]',
        interval_ticks INTEGER,
        next_due_at INTEGER,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (bot_id, name),
        FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS smart_user_messages (
        user_id TEXT PRIMARY KEY,
        overrides_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS feature_modules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        help_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT '',
        billing_mode TEXT NOT NULL DEFAULT 'hourly',
        price_momoc REAL NOT NULL DEFAULT 0,
        variables_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_bot_settings (
        user_id TEXT PRIMARY KEY,
        command_prefix TEXT NOT NULL DEFAULT '!',
        whitelist_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS bot_modules (
        bot_id TEXT NOT NULL,
        module_id TEXT NOT NULL,
        variables_json TEXT NOT NULL DEFAULT '{}',
        billed_minutes INTEGER NOT NULL DEFAULT 0,
        billing_remainder_micros INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (bot_id, module_id),
        FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
        FOREIGN KEY (module_id) REFERENCES feature_modules(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_accounts_user ON microsoft_accounts(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ledger_user ON momoc_ledger(user_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_smart_permissions_expiry ON smart_permissions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_smart_permissions_owner ON smart_permissions(owner_user_id, role, player_name);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_smart_bot_prefix_unique
        ON smart_bot_settings(command_prefix COLLATE NOCASE)
        WHERE command_prefix <> '';
    `)
    this.removeTemplateLayer()
    this.migrateSmartPrefixes()
    this.ensureColumn('bots', 'account_id', 'TEXT')
    this.ensureColumn('bots', 'mode', "TEXT NOT NULL DEFAULT 'smart'")
    this.ensureColumn('bots', 'mode_vars_json', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('bots', 'template_vars_json', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('users', 'momoc_units', 'INTEGER')
    this.ensureColumn('users', 'reserved_momoc_units', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('users', 'momoc_micros', 'INTEGER')
    this.ensureColumn('users', 'reserved_momoc_micros', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('users', 'auth_source', "TEXT NOT NULL DEFAULT 'local'")
    this.ensureColumn('users', 'external_id', 'TEXT')
    this.ensureColumn('bots', 'billing_remainder_micros', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('bots', 'schedule_enabled', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('bots', 'schedule_cron', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('momoc_ledger', 'units', 'INTEGER NOT NULL DEFAULT 1')
    this.ensureColumn('momoc_ledger', 'started_at', 'TEXT')
    this.ensureColumn('momoc_ledger', 'delta_units', 'INTEGER')
    this.ensureColumn('momoc_ledger', 'balance_after_units', 'INTEGER')
    this.ensureColumn('momoc_ledger', 'delta_micros', 'INTEGER')
    this.ensureColumn('momoc_ledger', 'balance_after_micros', 'INTEGER')
    this.ensureColumn('momoc_ledger', 'module_id', 'TEXT')
    this.ensureColumn('bot_modules', 'billing_remainder_micros', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('feature_modules', 'instructions', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('feature_modules', 'help_json', "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn('smart_bot_automation', 'periodic_right_click_enabled', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('smart_bot_automation', 'periodic_right_click_x', 'INTEGER')
    this.ensureColumn('smart_bot_automation', 'periodic_right_click_y', 'INTEGER')
    this.ensureColumn('smart_bot_automation', 'periodic_right_click_z', 'INTEGER')
    this.ensureColumn('smart_bot_automation', 'periodic_right_click_interval_ticks', 'INTEGER NOT NULL DEFAULT 20')
    this.ensureColumn('smart_bot_automation', 'periodic_right_click_last_run_at', 'INTEGER')
    this.ensureColumn('smart_bot_automation', 'periodic_right_click_next_due_at', 'INTEGER')
    this.ensureColumn('smart_bot_settings', 'message_overrides_json', "TEXT NOT NULL DEFAULT '{}'")
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external_identity ON users(auth_source, external_id) WHERE external_id IS NOT NULL AND external_id <> ''")
    this.db.exec('DROP TABLE IF EXISTS bot_modules; DROP TABLE IF EXISTS feature_modules; DROP TABLE IF EXISTS user_bot_settings;')
    this.db.prepare("INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('smart_hourly_price', '0.03')").run()
    this.db.prepare("INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('signin_once_price', '0.01')").run()
    this.db.prepare("INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('registration_enabled', '0')").run()
    this.db.prepare("INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('smart_max_running_bots', '0')").run()
    this.db.prepare("INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('bot_creation_enabled', '1')").run()
    this.db.prepare('UPDATE users SET momoc_units = CAST(ROUND(momoc * 60) AS INTEGER) WHERE momoc_units IS NULL').run()
    this.db.prepare('UPDATE momoc_ledger SET delta_units = CAST(ROUND(delta * 60) AS INTEGER) WHERE delta_units IS NULL').run()
    this.db.prepare('UPDATE momoc_ledger SET balance_after_units = CAST(ROUND(balance_after * 60) AS INTEGER) WHERE balance_after_units IS NULL').run()
    this.db.prepare('UPDATE users SET momoc_micros = CAST(ROUND(momoc * 1000000) AS INTEGER) WHERE momoc_micros IS NULL').run()
    this.db.prepare('UPDATE momoc_ledger SET delta_micros = CAST(ROUND(delta * 1000000) AS INTEGER) WHERE delta_micros IS NULL').run()
    this.db.prepare('UPDATE momoc_ledger SET balance_after_micros = CAST(ROUND(balance_after * 1000000) AS INTEGER) WHERE balance_after_micros IS NULL').run()
    this.migrateLegacyAdminIdentity()
    this.migrateBotAccounts()
  }

  recoverBotRuntimeAfterSupervisorStart () {
    this.db.prepare('UPDATE users SET reserved_momoc_units = 0, reserved_momoc_micros = 0').run()
    this.db.prepare("UPDATE bots SET runtime_state = 'stopped', oauth_json = '', started_at = NULL WHERE runtime_state <> 'stopped'").run()
  }

  ensureColumn (table, column, definition) {
    const exists = this.db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)
    if (!exists) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  removeTemplateLayer () {
    const columns = this.db.prepare('PRAGMA table_info(bots)').all()
    if (!columns.some(row => row.name === 'template_id')) return
    const names = columns.map(row => row.name).filter(name => name !== 'template_id')
    this.db.pragma('foreign_keys = OFF')
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE bots_new (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT, label TEXT NOT NULL,
        microsoft_email TEXT NOT NULL, server_host TEXT NOT NULL, server_port INTEGER NOT NULL DEFAULT 25565,
        minecraft_version TEXT NOT NULL DEFAULT '', desired_state TEXT NOT NULL DEFAULT 'stopped',
        runtime_state TEXT NOT NULL DEFAULT 'stopped', minecraft_name TEXT NOT NULL DEFAULT '',
        template_vars_json TEXT NOT NULL DEFAULT '{}', last_error TEXT NOT NULL DEFAULT '', oauth_json TEXT NOT NULL DEFAULT '',
        started_at INTEGER, billed_minutes INTEGER NOT NULL DEFAULT 0, billing_remainder_micros INTEGER NOT NULL DEFAULT 0,
        schedule_enabled INTEGER NOT NULL DEFAULT 0, schedule_cron TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (account_id) REFERENCES microsoft_accounts(id) ON DELETE RESTRICT
      )`)
      this.db.prepare(`INSERT INTO bots_new (${names.join(',')}) SELECT ${names.join(',')} FROM bots`).run()
      this.db.exec('DROP TABLE bots; ALTER TABLE bots_new RENAME TO bots; DROP TABLE IF EXISTS bot_templates; CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id, created_at);')
    })()
    this.db.pragma('foreign_keys = ON')
  }

  migrateSmartPrefixes () {
    const legacy = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'smart_user_settings'").get()
    if (!legacy) return
    this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT owner_user_id AS ownerUserId, command_prefix AS commandPrefix
        FROM smart_user_settings
        WHERE command_prefix <> ''
      `).all()
      const firstSmartBot = this.db.prepare("SELECT id FROM bots WHERE user_id = ? AND mode = 'smart' ORDER BY created_at, id LIMIT 1")
      const prefixTaken = this.db.prepare('SELECT 1 FROM smart_bot_settings WHERE command_prefix = ? COLLATE NOCASE')
      const insert = this.db.prepare('INSERT OR IGNORE INTO smart_bot_settings (bot_id, command_prefix) VALUES (?, ?)')
      for (const row of rows) {
        const bot = firstSmartBot.get(row.ownerUserId)
        if (bot && !prefixTaken.get(row.commandPrefix)) insert.run(bot.id, row.commandPrefix)
      }
      this.db.exec('DROP TABLE smart_user_settings')
    })()
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

  migrateLegacyAdminIdentity () {
    const adminName = String(this.config.cloudStoreAdminUsername || 'Damomo1')
    const legacy = this.db.prepare("SELECT id FROM users WHERE username = 'admin' COLLATE NOCASE LIMIT 1").get()
    const target = this.db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE LIMIT 1').get(adminName)
    if (legacy && !target) {
      this.db.prepare("UPDATE users SET username = ?, role = 'admin', auth_source = 'cloud_store', external_id = NULL WHERE id = ?").run(adminName, legacy.id)
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(legacy.id)
    } else if (target) {
      this.db.prepare("UPDATE users SET role = 'admin', auth_source = 'cloud_store' WHERE id = ?").run(target.id)
      if (legacy && legacy.id !== target.id) this.db.prepare("UPDATE users SET username = ?, role = 'user' WHERE id = ?").run(`legacy_admin_${legacy.id.slice(0, 8)}`, legacy.id)
    }
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
    return row && row.auth_source === 'local' && verifyPassword(password, row.password_hash) ? this.publicUser(row) : null
  }

  publicUser (row) {
    if (!row) return null
    const momoc = Number(row.momoc_micros || 0) / MOMOC_SCALE
    const reservedMomoc = Number(row.reserved_momoc_micros || 0) / MOMOC_SCALE
    return { id: row.id, username: row.username, role: row.role, authSource: row.auth_source || 'local', momoc, reservedMomoc, availableMomoc: momoc - reservedMomoc, createdAt: row.created_at }
  }

  getUser (id) {
    return this.publicUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id))
  }

  listUsers () {
    return this.db.prepare('SELECT * FROM users ORDER BY role = \'admin\' DESC, username COLLATE NOCASE').all().map(row => this.publicUser(row))
  }

  listPlatformAdmins () {
    return this.db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY username COLLATE NOCASE").all().map(row => this.publicUser(row))
  }

  addPlatformAdmin (username) {
    const name = String(username || '').trim()
    const user = this.db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE LIMIT 1').get(name)
    if (!user) throw new Error('该玩家还没有从云仓库进入过平台。')
    this.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id)
    return this.getUser(user.id)
  }

  removePlatformAdmin (userId, options = {}) {
    const user = this.getUser(userId)
    if (!user || user.role !== 'admin') throw new Error('平台管理员不存在。')
    if (user.username.toLowerCase() === String(options.rootUsername || 'Damomo1').toLowerCase()) throw new Error('Damomo1 是根管理员，不能删除。')
    if (user.id === options.actorUserId) throw new Error('不能删除当前登录账号的管理员权限。')
    this.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(user.id)
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id)
    return this.getUser(user.id)
  }

  setUserPassword (userId, password) {
    const value = String(password || '')
    if (value.length < 8 || value.length > 128) throw new Error('密码必须为 8-128 个字符。')
    const user = this.db.prepare('SELECT auth_source AS authSource FROM users WHERE id = ?').get(userId)
    if (user?.authSource === 'cloud_store') throw new Error('云仓库用户不使用本地密码。')
    const changed = this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(value), userId).changes
    if (!changed) throw new Error('用户不存在。')
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
    return true
  }

  changeUserPassword (userId, currentPassword, newPassword) {
    const row = this.db.prepare('SELECT password_hash, auth_source AS authSource FROM users WHERE id = ?').get(userId)
    if (row?.authSource === 'cloud_store') throw new Error('云仓库用户不使用本地密码。')
    if (!row || !verifyPassword(currentPassword, row.password_hash)) throw new Error('当前密码不正确。')
    return this.setUserPassword(userId, newPassword)
  }

  upsertCloudStoreUser (externalId, username, adminUsername = 'Damomo1') {
    const identity = String(externalId || '').trim()
    const name = String(username || '').trim()
    if (!identity || !/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error('云仓库玩家身份无效。')
    const rootAdmin = name.toLowerCase() === String(adminUsername || 'Damomo1').toLowerCase()
    let row = this.db.prepare("SELECT * FROM users WHERE auth_source = 'cloud_store' AND external_id = ? LIMIT 1").get(identity)
    if (!row) row = this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE LIMIT 1').get(name)
    if (row) {
      const role = rootAdmin || row.role === 'admin' ? 'admin' : 'user'
      this.db.prepare("UPDATE users SET username = ?, role = ?, auth_source = 'cloud_store', external_id = ? WHERE id = ?").run(name, role, identity, row.id)
      return this.getUser(row.id)
    }
    const role = rootAdmin ? 'admin' : 'user'
    const id = crypto.randomUUID()
    this.db.prepare("INSERT INTO users (id, username, password_hash, role, auth_source, external_id, momoc_units, momoc_micros) VALUES (?, ?, ?, ?, 'cloud_store', ?, 0, 0)").run(id, name, hashPassword(crypto.randomBytes(32).toString('base64url')), role, identity)
    return this.getUser(id)
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

  listFeatureModules (includeDisabled = false) {
    return this.db.prepare(`SELECT id, name, description, instructions, help_json AS helpJson, source, billing_mode AS billingMode, price_momoc AS priceMomoc, variables_json AS variablesJson, enabled, created_at AS createdAt, updated_at AS updatedAt FROM feature_modules ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY name COLLATE NOCASE`).all().map(row => {
      let variables = []; let help = []
      try { variables = JSON.parse(row.variablesJson || '[]') } catch {}
      try { help = JSON.parse(row.helpJson || '[]') } catch {}
      const { variablesJson, helpJson, ...safe } = row
      return { ...safe, priceMomoc: Number(row.priceMomoc || 0), enabled: Boolean(row.enabled), variables, help }
    })
  }

  saveFeatureModule ({ id, source, enabled = true }) {
    const moduleId = String(id || crypto.randomUUID())
    const parsed = parseModuleSource(source)
    const price = toMomocMicros(parsed.billing.priceMomoc, '模块价格') / MOMOC_SCALE
    this.db.prepare(`INSERT INTO feature_modules (id, name, description, instructions, help_json, source, billing_mode, price_momoc, variables_json, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, instructions=excluded.instructions, help_json=excluded.help_json, source=excluded.source, billing_mode=excluded.billing_mode, price_momoc=excluded.price_momoc, variables_json=excluded.variables_json, enabled=excluded.enabled, updated_at=CURRENT_TIMESTAMP`).run(moduleId, parsed.name, parsed.description, parsed.instructions, JSON.stringify(parsed.help), parsed.source, parsed.billing.mode, price, JSON.stringify(parsed.variables), enabled ? 1 : 0)
    return this.listFeatureModules(true).find(row => row.id === moduleId)
  }

  getBaseHourlyPrice () {
    return this.getModePrices().smartHourlyPrice
  }

  getModePrices () {
    return {
      smartHourlyPrice: Number(this.db.prepare("SELECT value FROM platform_settings WHERE key = 'smart_hourly_price'").get()?.value || 0.03),
      signinOncePrice: Number(this.db.prepare("SELECT value FROM platform_settings WHERE key = 'signin_once_price'").get()?.value || 0.01)
    }
  }

  getRegistrationEnabled () {
    return this.db.prepare("SELECT value FROM platform_settings WHERE key = 'registration_enabled'").get()?.value !== '0'
  }

  getRuntimeSettings () {
    const value = key => this.db.prepare('SELECT value FROM platform_settings WHERE key = ?').get(key)?.value
    const maxRunningBots = Number.parseInt(value('smart_max_running_bots') || '0', 10)
    return {
      maxRunningBots: Number.isInteger(maxRunningBots) && maxRunningBots >= 0 ? maxRunningBots : 0,
      botCreationEnabled: value('bot_creation_enabled') !== '0'
    }
  }

  setRuntimeSettings (input = {}) {
    const save = this.db.prepare('INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    if (Object.prototype.hasOwnProperty.call(input, 'maxRunningBots')) {
      const max = Number(input.maxRunningBots)
      if (!Number.isInteger(max) || max < 0 || max > 100000) throw new Error('智能 Bot 最大运行数必须为 0-100000。')
      save.run('smart_max_running_bots', String(max))
    }
    if (Object.prototype.hasOwnProperty.call(input, 'botCreationEnabled')) save.run('bot_creation_enabled', input.botCreationEnabled ? '1' : '0')
    return this.getRuntimeSettings()
  }

  setRegistrationEnabled (enabled) {
    this.db.prepare("INSERT INTO platform_settings (key, value) VALUES ('registration_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(enabled ? '1' : '0')
    return this.getRegistrationEnabled()
  }

  getUserBotSettings (userId) {
    const row = this.db.prepare('SELECT command_prefix AS commandPrefix, whitelist_json AS whitelistJson FROM user_bot_settings WHERE user_id = ?').get(userId)
    let whitelist = []
    try { whitelist = JSON.parse(row?.whitelistJson || '[]') } catch {}
    return { commandPrefix: row?.commandPrefix || '!', whitelist }
  }

  saveUserBotSettings (userId, input) {
    const commandPrefix = String(input.commandPrefix || '').trim()
    if (!commandPrefix || commandPrefix.length > 8 || /\s/.test(commandPrefix)) throw new Error('命令前缀必须是 1-8 个不含空格的字符。')
    const whitelist = [...new Set((Array.isArray(input.whitelist) ? input.whitelist : []).map(name => String(name || '').trim()).filter(name => /^[A-Za-z0-9_]{3,16}$/.test(name)).map(name => name.toLowerCase()))]
    if (whitelist.length > 200) throw new Error('白名单最多 200 名玩家。')
    this.db.prepare(`INSERT INTO user_bot_settings (user_id, command_prefix, whitelist_json, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET command_prefix=excluded.command_prefix, whitelist_json=excluded.whitelist_json, updated_at=CURRENT_TIMESTAMP`).run(userId, commandPrefix, JSON.stringify(whitelist))
    return this.getUserBotSettings(userId)
  }

  seedMinecartModule () {
    const exists = this.db.prepare("SELECT 1 FROM feature_modules WHERE name = '矿车交互'").get()
    if (exists) return
    const source = `module.exports = defineModule({
  name: '矿车交互',
  description: '使用游戏内命令让 Bot 乘坐最近的矿车或离开当前矿车。',
  instructions: 'Bot 必须在矿车附近。命令需要加上你设置的命令前缀，例如前缀为 @ 时发送 @上矿车 或 @下车。',
  help: [
    { command: '上矿车', description: '寻找附近最近的矿车并右键乘坐' },
    { command: '下车', description: '让 Bot 离开当前乘坐的矿车' }
  ],
  billing: { mode: 'once', priceMomoc: 0 },
  variables: [
    { key: 'max_distance', label: '矿车搜索距离', type: 'number', default: 6, min: 1, max: 32, step: 1 }
  ]
}, ({ bot, variables, platform, command }) => {
  command({ pattern: /^上矿车$/ }, async event => {
    const limit = Number(variables.max_distance || 6)
    const minecart = bot.nearestEntity(entity => String(entity.name || entity.displayName || '').toLowerCase().includes('minecart'))
    if (!minecart || bot.entity.position.distanceTo(minecart.position) > limit) return
    await bot.activateEntity(minecart)
    platform.success('已乘坐最近的矿车')
  })
  command({ pattern: /^下车$/ }, async event => {
    if (!bot.vehicle) return
    bot.dismount()
    platform.success('已离开矿车')
  })
})`
    this.saveFeatureModule({ source })
  }

  setBaseHourlyPrice (value) {
    const price = toMomocMicros(value, '基础挂机价格') / MOMOC_SCALE
    this.db.prepare("INSERT INTO platform_settings (key, value) VALUES ('base_hourly_price', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(price))
    return price
  }

  setModePrices (input) {
    const current = this.getModePrices()
    const smart = toMomocMicros(input.smartHourlyPrice ?? current.smartHourlyPrice, '智能 Bot 每小时价格') / MOMOC_SCALE
    const signin = toMomocMicros(input.signinOncePrice ?? current.signinOncePrice, '签到 Bot 每次价格') / MOMOC_SCALE
    const save = this.db.prepare('INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    save.run('smart_hourly_price', String(smart)); save.run('signin_once_price', String(signin))
    return this.getModePrices()
  }

  deleteFeatureModule (id) {
    const used = this.db.prepare('SELECT COUNT(*) AS count FROM bot_modules WHERE module_id = ?').get(id).count
    if (used) throw new Error('这个功能模块仍被机器人使用，不能删除。')
    return this.db.prepare('DELETE FROM feature_modules WHERE id = ?').run(id).changes
  }

  setBotModules (botId, selections) {
    return this.db.transaction(() => {
      const selectedIds = []
      const insert = this.db.prepare('INSERT INTO bot_modules (bot_id, module_id, variables_json) VALUES (?, ?, ?) ON CONFLICT(bot_id, module_id) DO UPDATE SET variables_json = excluded.variables_json')
      for (const selection of selections || []) {
        const available = this.db.prepare('SELECT 1 FROM feature_modules WHERE id = ? AND enabled = 1').get(selection.moduleId)
        if (!available) throw new Error('功能模块不可用。')
        selectedIds.push(selection.moduleId)
        insert.run(botId, selection.moduleId, JSON.stringify(selection.variables || {}))
      }
      if (selectedIds.length) this.db.prepare(`DELETE FROM bot_modules WHERE bot_id = ? AND module_id NOT IN (${selectedIds.map(() => '?').join(',')})`).run(botId, ...selectedIds)
      else this.db.prepare('DELETE FROM bot_modules WHERE bot_id = ?').run(botId)
      return this.listBotModules(botId)
    })()
  }

  listBotModules (botId) {
    return this.db.prepare(`SELECT m.id, m.name, m.description, m.source, m.billing_mode AS billingMode, m.price_momoc AS priceMomoc, m.variables_json AS definitionsJson, bm.variables_json AS valuesJson, bm.billed_minutes AS billedMinutes, bm.billing_remainder_micros AS billingRemainderMicros FROM bot_modules bm JOIN feature_modules m ON m.id = bm.module_id WHERE bm.bot_id = ? AND m.enabled = 1 ORDER BY m.name COLLATE NOCASE`).all(botId).map(row => {
      let variables = {}; let definitions = []
      try { variables = JSON.parse(row.valuesJson || '{}') } catch {}
      try { definitions = JSON.parse(row.definitionsJson || '[]') } catch {}
      const { valuesJson, definitionsJson, ...safe } = row
      return { ...safe, priceMomoc: Number(row.priceMomoc || 0), billedMinutes: Number(row.billedMinutes || 0), variables, definitions }
    })
  }

  chargeModule (botId, moduleId, mode, price, detail = '') {
    const bot = this.getBot(botId)
    const module = this.listBotModules(botId).find(row => row.id === moduleId && row.billingMode === mode)
    if (!bot || !module) return { ok: false, reason: '模块不存在或未启用' }
    try {
      const rateMicros = toMomocMicros(price, '模块价格')
      const accruedMicros = mode === 'hourly' ? Number(module.billingRemainderMicros || 0) + rateMicros : rateMicros
      const costMicros = mode === 'hourly' ? Math.floor(accruedMicros / 60) : rateMicros
      const remainderMicros = mode === 'hourly' ? accruedMicros % 60 : 0
      const balance = this.db.transaction(() => {
        const user = this.db.prepare('SELECT momoc_micros AS balance, reserved_momoc_micros AS reserved FROM users WHERE id = ?').get(bot.userId)
        const nextMicros = Number(user.balance || 0) - costMicros
        if (nextMicros < Number(user.reserved || 0)) throw new Error('可用 momoc 余额不足。')
        const next = nextMicros / MOMOC_SCALE
        this.db.prepare('UPDATE users SET momoc = ?, momoc_units = ?, momoc_micros = ? WHERE id = ?').run(next, Math.round(next * 60), nextMicros, bot.userId)
        const kind = mode === 'hourly' ? 'module_hourly' : 'module_once'
        const note = `${module.name}${mode === 'hourly' ? ' 运行 1 分钟' : ` 执行成功${detail ? `：${String(detail).slice(0, 160)}` : ''}`}`
        if (costMicros > 0) this.db.prepare('INSERT INTO momoc_ledger (user_id, delta, balance_after, delta_micros, balance_after_micros, kind, note, bot_id, module_id, units, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)').run(bot.userId, -costMicros / MOMOC_SCALE, next, -costMicros, nextMicros, kind, note, botId, moduleId)
        if (mode === 'hourly') this.db.prepare('UPDATE bot_modules SET billed_minutes = billed_minutes + 1, billing_remainder_micros = ? WHERE bot_id = ? AND module_id = ?').run(remainderMicros, botId, moduleId)
        return next
      })()
      return { ok: true, balance, charged: costMicros / MOMOC_SCALE }
    } catch (error) { return { ok: false, reason: error.message } }
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

  cleanupExpiredSmartPermissions (now = Date.now()) {
    return this.db.prepare('DELETE FROM smart_permissions WHERE expires_at IS NOT NULL AND expires_at <= ?').run(Number(now)).changes
  }

  listSmartPermissions (ownerUserId, now = Date.now()) {
    this.cleanupExpiredSmartPermissions(now)
    return this.db.prepare(`
      SELECT player_name AS playerName, role, expires_at AS expiresAt, created_by AS createdBy,
             created_at AS createdAt, updated_at AS updatedAt
      FROM smart_permissions
      WHERE owner_user_id = ?
      ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'whitelist' THEN 1 ELSE 2 END, player_name COLLATE NOCASE
    `).all(ownerUserId)
  }

  getSmartAccess (ownerUserId, playerName, now = Date.now()) {
    const name = normalizeSmartPlayerName(playerName)
    const roles = new Set(this.db.prepare(`
      SELECT role FROM smart_permissions
      WHERE owner_user_id = ? AND player_name = ? COLLATE NOCASE
        AND (expires_at IS NULL OR expires_at > ?)
    `).all(ownerUserId, name, Number(now)).map(row => row.role))
    const admin = roles.has('admin')
    return {
      playerName: name,
      blacklisted: roles.has('blacklist'),
      admin,
      whitelisted: admin || roles.has('whitelist')
    }
  }

  getSmartAccessForBot (botId, playerName, now = Date.now()) {
    const bot = this.getBot(botId)
    if (!bot) throw new Error('机器人不存在。')
    return { ...this.getSmartAccess(bot.userId, playerName, now), ownerUserId: bot.userId, lock: this.getSmartBotLock(botId) }
  }

  getSmartPermission (ownerUserId, playerName, role, now = Date.now()) {
    const name = normalizeSmartPlayerName(playerName)
    if (!['whitelist', 'blacklist', 'admin'].includes(role)) throw new Error('权限类型无效。')
    const row = this.db.prepare(`
      SELECT player_name AS playerName, role, expires_at AS expiresAt, created_by AS createdBy,
             created_at AS createdAt, updated_at AS updatedAt
      FROM smart_permissions
      WHERE owner_user_id = ? AND player_name = ? COLLATE NOCASE AND role = ?
        AND (expires_at IS NULL OR expires_at > ?)
    `).get(ownerUserId, name, role, Number(now))
    if (row || role !== 'whitelist') return row || null
    return this.db.prepare(`
      SELECT player_name AS playerName, 'whitelist' AS role, expires_at AS expiresAt, created_by AS createdBy,
             created_at AS createdAt, updated_at AS updatedAt
      FROM smart_permissions
      WHERE owner_user_id = ? AND player_name = ? COLLATE NOCASE AND role = 'admin'
        AND (expires_at IS NULL OR expires_at > ?)
    `).get(ownerUserId, name, Number(now)) || null
  }

  getSmartBotSettings (botId) {
    const row = this.db.prepare('SELECT command_prefix AS commandPrefix, message_overrides_json AS messageOverridesJson, updated_at AS updatedAt FROM smart_bot_settings WHERE bot_id = ?').get(botId)
    const bot = this.getBot(botId)
    if (!row) return { commandPrefix: '', messageOverrides: bot ? this.getSmartUserMessages(bot.userId) : {}, updatedAt: null }
    row.messageOverrides = bot ? this.getSmartUserMessages(bot.userId) : {}
    delete row.messageOverridesJson
    return row
  }

  getSmartUserMessages (userId) {
    const row = this.db.prepare('SELECT overrides_json AS overridesJson FROM smart_user_messages WHERE user_id = ?').get(userId)
    try { return JSON.parse(row?.overridesJson || '{}') } catch { return {} }
  }

  setSmartUserMessages (userId, overrides = {}) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('自定义消息格式无效。')
    const allowed = new Set(['permissionUsage', 'permissionResult', 'openBoxUsage', 'openBoxSuccess', 'openBoxFailure', 'nearUsage', 'nearSuccess', 'nearEmpty', 'nearFailure', 'mountAlready', 'mountMissing', 'mountSuccess', 'mountFailure', 'dismountMissing', 'dismountSuccess', 'dismountFailure', 'vaultSuccess', 'vaultMissing', 'vaultFailure', 'clearEmpty', 'clearSuccess', 'clearFailure', 'switchUsage', 'switchSuccess', 'ominousUsage', 'ominousEnabled', 'ominousDisabled', 'ominousStatusOn', 'ominousStatusOff', 'periodicRightClickUsage', 'periodicRightClickEnabled', 'periodicRightClickDisabled', 'periodicRightClickStatusOff', 'periodicRightClickStatusOn', 'rightClickUsage', 'rightClickSuccess', 'rightClickFailure', 'placeUsage', 'placeSuccess', 'placeFailure', 'taskUsage', 'taskScheduled', 'taskStopped', 'scheduleStatus', 'locked', 'lockUsage', 'alreadyLocked', 'lockSuccess', 'notLocked', 'adminUnlockRequired', 'unlockSuccess', 'forwardUsage', 'forwardInvalid', 'forwardNested', 'forwardDangerous', 'forwardHome', 'restartLocked', 'restarting', 'permissionAdded', 'permissionExists', 'permissionRemoved', 'permissionMissing', 'temporaryUsage', 'temporaryAdded', 'adminLockUsage', 'alreadyAdminLocked', 'adminLockSuccess', 'notAdminLocked', 'adminUnlockSuccess'])
    const normalized = {}
    for (const [key, value] of Object.entries(overrides)) {
      if (!allowed.has(key)) throw new Error(`不支持的消息项: ${key}`)
      normalized[key] = String(value ?? '').slice(0, 256)
    }
    this.db.prepare(`INSERT INTO smart_user_messages (user_id, overrides_json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET overrides_json=excluded.overrides_json, updated_at=CURRENT_TIMESTAMP`).run(userId, JSON.stringify(normalized))
    return normalized
  }

  setSmartBotSettings (botId, input = {}) {
    const bot = this.getBot(botId)
    if (!bot || bot.mode !== 'smart') throw new Error('智能 Bot 不存在。')
    const current = this.getSmartBotSettings(botId)
    const commandPrefix = String(input.commandPrefix ?? current.commandPrefix ?? '').trim()
    if (/[\u0000\r\n]/.test(commandPrefix)) throw new Error('命令前缀不能包含换行或空字符。')
    if (commandPrefix && /[\p{L}\p{N}]$/u.test(commandPrefix)) throw new Error('命令前缀必须以特殊符号结尾，不能以字母或数字结尾。')
    const conflict = commandPrefix && this.db.prepare(`
      SELECT b.label, COALESCE(NULLIF(b.minecraft_name, ''), a.minecraft_name, '') AS minecraftName
      FROM smart_bot_settings s
      JOIN bots b ON b.id = s.bot_id
      LEFT JOIN microsoft_accounts a ON a.id = b.account_id
      WHERE s.command_prefix = ? COLLATE NOCASE AND s.bot_id <> ?
    `).get(commandPrefix, botId)
    if (conflict) throw new Error(`命令前缀“${commandPrefix}”已被其他 Bot 使用。`)
    this.db.prepare(`
      INSERT INTO smart_bot_settings (bot_id, command_prefix, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(bot_id) DO UPDATE SET
        command_prefix = excluded.command_prefix,
        updated_at = CURRENT_TIMESTAMP
    `).run(botId, commandPrefix)
    return this.getSmartBotSettings(botId)
  }

  listSmartBotTasks (botId) {
    return this.db.prepare('SELECT name, steps_json AS stepsJson, interval_ticks AS intervalTicks, next_due_at AS nextDueAt, updated_at AS updatedAt FROM smart_bot_tasks WHERE bot_id = ? ORDER BY name COLLATE NOCASE').all(botId).map(row => ({ ...row, steps: JSON.parse(row.stepsJson || '[]'), stepsJson: undefined }))
  }

  getSmartBotScheduleStatus (botId) {
    const automation = this.getSmartBotAutomation(botId)
    const tasks = this.listSmartBotTasks(botId)
      .filter(task => task.intervalTicks != null)
      .map(task => ({ name: task.name, intervalTicks: task.intervalTicks, nextDueAt: task.nextDueAt }))
    return { automation, tasks }
  }

  getSmartBotTask (botId, name) {
    const key = String(name || '').trim()
    if (!key) return null
    return this.listSmartBotTasks(botId).find(row => row.name.toLowerCase() === key.toLowerCase()) || null
  }

  setSmartBotTask (botId, input = {}) {
    const name = String(input.name || '').trim()
    const steps = input.steps
    if (!name || name.length > 32 || /\s/.test(name)) throw new Error('任务名必须为 1-32 个不含空格的字符。')
    if (!Array.isArray(steps) || !steps.length || steps.length > 100) throw new Error('任务必须包含 1-100 个步骤。')
    const allowedCommands = new Set(['上车', '下车', '清空', '切换', '放置', '右键', '指令'])
    const normalizedSteps = steps.map((step, index) => {
      if (!step || typeof step !== 'object') throw new Error(`第 ${index + 1} 步无效。`)
      if (step.type === 'wait') {
        const ticks = Number(step.ticks)
        if (!Number.isInteger(ticks) || ticks < 1 || ticks > 28800) throw new Error(`第 ${index + 1} 步等待时间必须为 1-28800gt。`)
        return { type: 'wait', ticks }
      }
      const command = String(step.command || '').trim()
      const args = Array.isArray(step.args) ? step.args.map(value => String(value).trim()).filter(Boolean) : []
      if (!allowedCommands.has(command)) throw new Error(`第 ${index + 1} 步不是可用的平台命令。`)
      if (['上车', '下车', '清空'].includes(command) && args.length) throw new Error(`${command} 命令不需要参数。`)
      if (command === '切换' && (args.length !== 1 || !/^[1-9]$/.test(args[0]))) throw new Error('切换命令参数必须为 1-9。')
      if (command === '放置' && (args.length !== 3 || !args.every(value => /^-?\d+$/.test(value)))) throw new Error('放置命令需要三个整数坐标。')
      if (command === '右键' && !((args.length === 1 && args[0].length <= 32) || (args.length === 3 && args.every(value => /^-?\d+$/.test(value))))) throw new Error('右键命令需要玩家名或三个整数坐标。')
      if (command === '指令') {
        const text = args.join(' ')
        const root = text.split(/\s+/, 1)[0].replace(/^\//, '').toLowerCase()
        if (!text || text.length > 256 || /[\r\n]/.test(text) || ['gmp', 'pay', 'msg'].includes(root) || root.includes('home')) throw new Error('指令内容无效或属于禁用命令。')
      }
      return { type: 'command', command, args }
    })
    for (let i = 0; i < normalizedSteps.length; i++) {
      const step = normalizedSteps[i]
      if (i % 2 === 0 && step.type === 'wait') throw new Error('任务必须以动作开始，并在动作之间插入等待。')
      if (i % 2 === 1 && (step.type !== 'wait' || !Number.isInteger(step.ticks) || step.ticks < 1)) throw new Error('每两个指令之间必须有至少 1gt 的等待步骤。')
    }
    if (normalizedSteps.length % 2 === 0) throw new Error('任务不能以等待步骤结束。')
    this.db.prepare(`INSERT INTO smart_bot_tasks (bot_id, name, steps_json) VALUES (?, ?, ?) ON CONFLICT(bot_id, name) DO UPDATE SET steps_json=excluded.steps_json, updated_at=CURRENT_TIMESTAMP`).run(botId, name, JSON.stringify(normalizedSteps))
    return this.getSmartBotTask(botId, name)
  }

  deleteSmartBotTask (botId, name) { return this.db.prepare('DELETE FROM smart_bot_tasks WHERE bot_id = ? AND name = ? COLLATE NOCASE').run(botId, String(name || '')).changes }

  scheduleSmartBotTask (botId, name, intervalTicks) {
    const ticks = intervalTicks == null ? null : Number(intervalTicks)
    if (ticks != null && (!Number.isInteger(ticks) || ticks < 1 || ticks > 1728000)) throw new Error('定时任务间隔必须为 1-1728000gt。')
    const result = this.db.prepare('UPDATE smart_bot_tasks SET interval_ticks = ?, next_due_at = ?, updated_at=CURRENT_TIMESTAMP WHERE bot_id = ? AND name = ? COLLATE NOCASE').run(ticks, ticks == null ? null : Date.now() + ticks * 50, botId, name)
    if (!result.changes) throw new Error('任务不存在。')
    return this.getSmartBotTask(botId, name)
  }

  completeSmartBotTaskSchedule (botId, name, options = {}) {
    const task = this.getSmartBotTask(botId, name)
    if (!task) throw new Error('任务不存在。')
    if (task.intervalTicks == null) return task
    const now = Number(options.now ?? Date.now())
    if (!Number.isFinite(now)) throw new Error('定时任务时间无效。')
    this.db.prepare('UPDATE smart_bot_tasks SET next_due_at = ?, updated_at=CURRENT_TIMESTAMP WHERE bot_id = ? AND name = ? COLLATE NOCASE AND interval_ticks IS NOT NULL').run(now + task.intervalTicks * 50, botId, task.name)
    return this.getSmartBotTask(botId, task.name)
  }

  resetSmartBotVolatileSchedules (botId) {
    this.db.prepare(`
      INSERT INTO smart_bot_automation (bot_id, periodic_right_click_enabled, periodic_right_click_next_due_at)
      VALUES (?, 0, NULL)
      ON CONFLICT(bot_id) DO UPDATE SET
        periodic_right_click_enabled = 0,
        periodic_right_click_next_due_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    `).run(botId)
    this.db.prepare('UPDATE smart_bot_tasks SET interval_ticks = NULL, next_due_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE bot_id = ?').run(botId)
    return { automation: this.getSmartBotAutomation(botId), tasks: this.listSmartBotTasks(botId) }
  }

  listSmartBotPrefixes (userId) {
    return this.db.prepare(`
      SELECT b.id, b.label,
             COALESCE(NULLIF(b.minecraft_name, ''), NULLIF(a.minecraft_name, ''), b.label) AS botName,
             COALESCE(s.command_prefix, '') AS commandPrefix
      FROM bots b
      LEFT JOIN microsoft_accounts a ON a.id = b.account_id
      LEFT JOIN smart_bot_settings s ON s.bot_id = b.id
      WHERE b.user_id = ? AND b.mode = 'smart'
      ORDER BY b.created_at DESC
    `).all(userId)
  }

  setSmartPermission (ownerUserId, playerName, role, options = {}) {
    const name = normalizeSmartPlayerName(playerName)
    if (!['whitelist', 'blacklist', 'admin'].includes(role)) throw new Error('权限类型无效。')
    let expiresAt = options.expiresAt == null ? null : Number(options.expiresAt)
    if (role === 'admin') expiresAt = null
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new Error('临时权限的到期时间无效。')
    const existing = this.db.prepare(`SELECT 1 FROM smart_permissions WHERE owner_user_id = ? AND player_name = ? COLLATE NOCASE AND role = ?`).get(ownerUserId, name, role)
    this.db.prepare(`
      INSERT INTO smart_permissions (owner_user_id, player_name, role, expires_at, created_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner_user_id, player_name, role) DO UPDATE SET
        player_name = excluded.player_name,
        expires_at = excluded.expires_at,
        created_by = excluded.created_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(ownerUserId, name, role, expiresAt, String(options.createdBy || '').slice(0, 32))
    return { added: !existing, permission: this.getSmartPermission(ownerUserId, name, role) }
  }

  removeSmartPermission (ownerUserId, playerName, role) {
    const name = normalizeSmartPlayerName(playerName)
    if (!['whitelist', 'blacklist', 'admin'].includes(role)) throw new Error('权限类型无效。')
    const result = this.db.prepare(`DELETE FROM smart_permissions WHERE owner_user_id = ? AND player_name = ? COLLATE NOCASE AND role = ?`).run(ownerUserId, name, role)
    return { removed: result.changes > 0, playerName: name, role }
  }

  getSmartBotLock (botId) {
    const row = this.db.prepare(`SELECT locked, admin_locked AS adminLocked, locked_by AS lockedBy, reason, updated_at AS updatedAt FROM smart_bot_locks WHERE bot_id = ?`).get(botId)
    return row
      ? { locked: Boolean(row.locked), adminLocked: Boolean(row.adminLocked), lockedBy: row.lockedBy, reason: row.reason, updatedAt: row.updatedAt }
      : { locked: false, adminLocked: false, lockedBy: '', reason: '', updatedAt: null }
  }

  setSmartBotLock (botId, input) {
    if (!this.getBot(botId)) throw new Error('机器人不存在。')
    const adminLocked = Boolean(input.adminLocked)
    const locked = adminLocked || Boolean(input.locked)
    const lockedBy = locked ? normalizeSmartPlayerName(input.lockedBy) : ''
    const reason = locked ? String(input.reason || '').trim().slice(0, 120) : ''
    this.db.prepare(`
      INSERT INTO smart_bot_locks (bot_id, locked, admin_locked, locked_by, reason)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(bot_id) DO UPDATE SET
        locked = excluded.locked,
        admin_locked = excluded.admin_locked,
        locked_by = excluded.locked_by,
        reason = excluded.reason,
        updated_at = CURRENT_TIMESTAMP
    `).run(botId, locked ? 1 : 0, adminLocked ? 1 : 0, lockedBy, reason)
    return this.getSmartBotLock(botId)
  }

  getSmartBotAutomation (botId) {
    const row = this.db.prepare(`
      SELECT ominous_bottle_enabled AS ominousBottleEnabled,
             ominous_bottle_last_used_at AS ominousBottleLastUsedAt,
             ominous_bottle_next_due_at AS ominousBottleNextDueAt,
             periodic_right_click_enabled AS periodicRightClickEnabled,
             periodic_right_click_x AS periodicRightClickX,
             periodic_right_click_y AS periodicRightClickY,
             periodic_right_click_z AS periodicRightClickZ,
             periodic_right_click_interval_ticks AS periodicRightClickIntervalTicks,
             periodic_right_click_last_run_at AS periodicRightClickLastRunAt,
             periodic_right_click_next_due_at AS periodicRightClickNextDueAt,
             updated_at AS updatedAt
      FROM smart_bot_automation
      WHERE bot_id = ?
    `).get(botId)
    return row
      ? {
          ominousBottleEnabled: Boolean(row.ominousBottleEnabled),
          ominousBottleLastUsedAt: row.ominousBottleLastUsedAt == null ? null : Number(row.ominousBottleLastUsedAt),
          ominousBottleNextDueAt: row.ominousBottleNextDueAt == null ? null : Number(row.ominousBottleNextDueAt),
          periodicRightClickEnabled: Boolean(row.periodicRightClickEnabled),
          periodicRightClickX: row.periodicRightClickX == null ? null : Number(row.periodicRightClickX),
          periodicRightClickY: row.periodicRightClickY == null ? null : Number(row.periodicRightClickY),
          periodicRightClickZ: row.periodicRightClickZ == null ? null : Number(row.periodicRightClickZ),
          periodicRightClickIntervalTicks: Number(row.periodicRightClickIntervalTicks || 20),
          periodicRightClickLastRunAt: row.periodicRightClickLastRunAt == null ? null : Number(row.periodicRightClickLastRunAt),
          periodicRightClickNextDueAt: row.periodicRightClickNextDueAt == null ? null : Number(row.periodicRightClickNextDueAt),
          updatedAt: row.updatedAt
        }
      : {
          ominousBottleEnabled: false,
          ominousBottleLastUsedAt: null,
          ominousBottleNextDueAt: null,
          periodicRightClickEnabled: false,
          periodicRightClickX: null,
          periodicRightClickY: null,
          periodicRightClickZ: null,
          periodicRightClickIntervalTicks: 20,
          periodicRightClickLastRunAt: null,
          periodicRightClickNextDueAt: null,
          updatedAt: null
        }
  }

  setSmartBotOminousBottle (botId, enabled, options = {}) {
    if (!this.getBot(botId)) throw new Error('机器人不存在。')
    const active = Boolean(enabled)
    const current = this.getSmartBotAutomation(botId)
    const now = Number(options.now ?? Date.now())
    const intervalMilliseconds = Number(options.intervalMilliseconds ?? 31 * 60 * 1000)
    if (!Number.isFinite(now) || !Number.isFinite(intervalMilliseconds) || intervalMilliseconds < 1000) throw new Error('定时配置无效。')
    const nextDueAt = active
      ? (current.ominousBottleEnabled && current.ominousBottleNextDueAt ? current.ominousBottleNextDueAt : now)
      : null
    this.db.prepare(`
      INSERT INTO smart_bot_automation (
        bot_id, ominous_bottle_enabled, ominous_bottle_last_used_at, ominous_bottle_next_due_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(bot_id) DO UPDATE SET
        ominous_bottle_enabled = excluded.ominous_bottle_enabled,
        ominous_bottle_next_due_at = excluded.ominous_bottle_next_due_at,
        updated_at = CURRENT_TIMESTAMP
    `).run(botId, active ? 1 : 0, current.ominousBottleLastUsedAt, nextDueAt)
    return this.getSmartBotAutomation(botId)
  }

  completeSmartBotOminousBottle (botId, options = {}) {
    const current = this.getSmartBotAutomation(botId)
    if (!current.ominousBottleEnabled) return current
    const now = Number(options.now ?? Date.now())
    const intervalMilliseconds = Number(options.intervalMilliseconds ?? 31 * 60 * 1000)
    if (!Number.isFinite(now) || !Number.isFinite(intervalMilliseconds) || intervalMilliseconds < 1000) throw new Error('定时配置无效。')
    this.db.prepare(`
      UPDATE smart_bot_automation
      SET ominous_bottle_last_used_at = ?, ominous_bottle_next_due_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE bot_id = ? AND ominous_bottle_enabled = 1
    `).run(now, now + intervalMilliseconds, botId)
    return this.getSmartBotAutomation(botId)
  }

  setSmartBotPeriodicRightClick (botId, input = {}, options = {}) {
    if (!this.getBot(botId)) throw new Error('机器人不存在。')
    const enabled = Boolean(input.enabled)
    const current = this.getSmartBotAutomation(botId)
    const now = Number(options.now ?? Date.now())
    const x = enabled ? Number(input.x) : current.periodicRightClickX
    const y = enabled ? Number(input.y) : current.periodicRightClickY
    const z = enabled ? Number(input.z) : current.periodicRightClickZ
    const intervalTicks = enabled ? Number(input.intervalTicks) : current.periodicRightClickIntervalTicks
    if (!Number.isFinite(now)) throw new Error('定期右键时间无效。')
    if (enabled && (![x, y, z].every(Number.isInteger) || [x, z].some(value => Math.abs(value) > 30000000) || y < -2048 || y > 2048)) throw new Error('定期右键坐标无效。')
    if (enabled && (!Number.isInteger(intervalTicks) || intervalTicks < 1 || intervalTicks > 1728000)) throw new Error('定期右键间隔必须为 1-1728000 游戏刻。')
    const nextDueAt = enabled ? now + intervalTicks * 50 : null
    this.db.prepare(`
      INSERT INTO smart_bot_automation (
        bot_id, periodic_right_click_enabled, periodic_right_click_x, periodic_right_click_y,
        periodic_right_click_z, periodic_right_click_interval_ticks,
        periodic_right_click_last_run_at, periodic_right_click_next_due_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id) DO UPDATE SET
        periodic_right_click_enabled = excluded.periodic_right_click_enabled,
        periodic_right_click_x = excluded.periodic_right_click_x,
        periodic_right_click_y = excluded.periodic_right_click_y,
        periodic_right_click_z = excluded.periodic_right_click_z,
        periodic_right_click_interval_ticks = excluded.periodic_right_click_interval_ticks,
        periodic_right_click_next_due_at = excluded.periodic_right_click_next_due_at,
        updated_at = CURRENT_TIMESTAMP
    `).run(botId, enabled ? 1 : 0, x, y, z, intervalTicks || 20, current.periodicRightClickLastRunAt, nextDueAt)
    return this.getSmartBotAutomation(botId)
  }

  completeSmartBotPeriodicRightClick (botId, options = {}) {
    const current = this.getSmartBotAutomation(botId)
    if (!current.periodicRightClickEnabled) return current
    const now = Number(options.now ?? Date.now())
    if (!Number.isFinite(now)) throw new Error('定期右键时间无效。')
    this.db.prepare(`
      UPDATE smart_bot_automation
      SET periodic_right_click_last_run_at = ?, periodic_right_click_next_due_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE bot_id = ? AND periodic_right_click_enabled = 1
    `).run(now, now + current.periodicRightClickIntervalTicks * 50, botId)
    return this.getSmartBotAutomation(botId)
  }

  createBot (userId, input) {
    const id = crypto.randomUUID()
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
    const mode = input.mode === 'signin' ? 'signin' : 'smart'
    const modeVariables = {}
    this.db.prepare(`INSERT INTO bots (id, user_id, account_id, mode, mode_vars_json, label, microsoft_email, server_host, server_port, minecraft_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, account.id, mode, JSON.stringify(modeVariables), String(input.label || 'Minecraft Bot').trim(), account.email, String(input.serverHost || '').trim(), port, String(input.minecraftVersion || '').trim())
    try {
      if (mode === 'smart') this.setSmartBotSettings(id, { commandPrefix: input.commandPrefix })
    } catch (error) {
      this.db.prepare('DELETE FROM bots WHERE id = ?').run(id)
      throw error
    }
    return this.getBot(id)
  }

  getBot (id) {
    const row = this.db.prepare(`SELECT b.id, b.user_id AS userId, u.username AS ownerUsername, b.account_id AS accountId, a.email AS microsoftEmail, a.minecraft_name AS accountMinecraftName, a.auth_state AS accountAuthState, b.mode, b.mode_vars_json AS modeVariablesJson, b.label, b.server_host AS serverHost, b.server_port AS serverPort, b.minecraft_version AS minecraftVersion, b.desired_state AS desiredState, b.runtime_state AS runtimeState, b.minecraft_name AS minecraftName, b.last_error AS lastError, b.oauth_json AS oauthJson, b.started_at AS startedAt, b.billed_minutes AS billedMinutes, b.billing_remainder_micros AS billingRemainderMicros, b.schedule_enabled AS scheduleEnabled, b.schedule_cron AS scheduleCron, b.created_at AS createdAt FROM bots b JOIN users u ON u.id=b.user_id JOIN microsoft_accounts a ON a.id=b.account_id WHERE b.id=?`).get(id) || null
    if (!row) return null
    try { row.modeVariables = JSON.parse(row.modeVariablesJson || '{}') } catch { row.modeVariables = {} }
    delete row.modeVariablesJson
    return row
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
        '' AS templateNames
      FROM microsoft_accounts a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN bots b ON b.account_id = a.id
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
        COALESCE(SUM(CASE WHEN l.kind IN ('bot_hourly', 'bot_minute', 'module_hourly') AND COALESCE(l.delta_micros, CAST(ROUND(l.delta * ${MOMOC_SCALE}) AS INTEGER)) < 0 THEN -COALESCE(l.delta_micros, CAST(ROUND(l.delta * ${MOMOC_SCALE}) AS INTEGER)) ELSE 0 END), 0) AS hourlyMicros,
        COALESCE(SUM(CASE WHEN l.kind IN ('bot_once', 'module_once') AND COALESCE(l.delta_micros, CAST(ROUND(l.delta * ${MOMOC_SCALE}) AS INTEGER)) < 0 THEN -COALESCE(l.delta_micros, CAST(ROUND(l.delta * ${MOMOC_SCALE}) AS INTEGER)) ELSE 0 END), 0) AS onceMicros,
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

    const bots = this.listBots().map(bot => {
      const commandPrefix = bot.mode === 'smart' ? this.getSmartBotSettings(bot.id).commandPrefix : ''
      const lock = bot.mode === 'smart' ? this.getSmartBotLock(bot.id) : { locked: false, adminLocked: false, lockedBy: '', reason: '', updatedAt: null }
      const smartSchedules = bot.mode === 'smart' ? this.getSmartBotScheduleStatus(bot.id) : null
      return { ...bot, commandPrefix, lock, smartSchedules, afkLocked: Boolean(lock.locked || lock.adminLocked) }
    })
    const runtime = this.getRuntimeSettings()
    return {
      stats: {
        users: consumption.length,
        accounts: accounts.length,
        authorizedAccounts: accounts.filter(row => row.authState === 'authorized').length,
        bots: bots.length,
        runningBots: bots.filter(row => row.runtimeState !== 'stopped').length,
        runningSmartBots: bots.filter(row => row.mode === 'smart' && row.runtimeState !== 'stopped').length,
        maxRunningBots: runtime.maxRunningBots,
        botCreationEnabled: runtime.botCreationEnabled,
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
