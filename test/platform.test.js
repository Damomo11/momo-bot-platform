const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const PlatformDb = require('../src/db')
const BotManager = require('../src/botManager')
const { environmentForValues, normalizeDefinitions, validateValues } = require('../src/templateVariables')
const { EventEmitter } = require('node:events')
const crypto = require('node:crypto')
const http = require('node:http')
const net = require('node:net')
const { execFileSync, spawn } = require('node:child_process')
const { installZenoxChatParser, normalizeServerChatText } = require('../src/zenoxChatParser')
const { verifyCloudStoreToken } = require('../src/cloudStoreSso')
const { LoginAttemptLimiter, clientIp } = require('../src/security')
const { invalidateMinecraftAccessTokenCache, isMinecraftProfileAuthError } = require('../src/authCache')
const { createOminousBottleScheduler, createPeriodicRightClickScheduler, createSmartCommandHandler, createTeleportRequestHandler, dismountVehicle, isVersionNewer, parsePeriodicRightClickArgs, parseSmartCommand, placePeriodicRightClick, rightClickTarget } = require('../smart-runtime/commands')

test('login attempts are blocked by IP after repeated failures', () => {
  const limiter = new LoginAttemptLimiter({ maxFailures: 3, windowMs: 1000, blockMs: 2000 })
  limiter.recordFailure('127.0.0.1', 0)
  limiter.recordFailure('127.0.0.1', 10)
  limiter.recordFailure('127.0.0.1', 20)
  assert.throws(() => limiter.assertAllowed('127.0.0.1', 21), error => error.status === 429)
  assert.doesNotThrow(() => limiter.assertAllowed('127.0.0.1', 2020))
})

test('client IP only trusts forwarding headers when configured', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } }
  assert.equal(clientIp(req, false), '127.0.0.1')
  assert.equal(clientIp(req, true), '203.0.113.9')
})

test('smart runtime versions compare numeric release parts', () => {
  assert.equal(isVersionNewer('1.0.4', '1.0.3'), true)
  assert.equal(isVersionNewer('1.1.0', '1.0.9'), true)
  assert.equal(isVersionNewer('2.0.0', '10.0.0'), false)
  assert.equal(isVersionNewer('1.0.3', '1.0.3'), false)
  assert.equal(isVersionNewer('invalid', '1.0.3'), false)
})

test('profile auth recovery only clears the short-lived Minecraft token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-auth-cache-'))
  try {
    const minecraftCache = path.join(root, 'account_mca-cache.json')
    const liveCache = path.join(root, 'account_live-cache.json')
    const xblCache = path.join(root, 'account_xbl-cache.json')
    fs.writeFileSync(minecraftCache, '{"mca":{"access_token":"expired"}}')
    fs.writeFileSync(liveCache, '{"refreshToken":"keep"}')
    fs.writeFileSync(xblCache, '{"xsts":"keep"}')
    assert.equal(invalidateMinecraftAccessTokenCache(root), 1)
    assert.equal(fs.readFileSync(minecraftCache, 'utf8'), '{}')
    assert.equal(fs.readFileSync(liveCache, 'utf8'), '{"refreshToken":"keep"}')
    assert.equal(fs.readFileSync(xblCache, 'utf8'), '{"xsts":"keep"}')
    assert.equal(isMinecraftProfileAuthError(new Error('Failed to obtain profile data for user@example.com')), true)
    assert.equal(isMinecraftProfileAuthError(new Error('read ECONNRESET')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function fixture () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-'))
  const config = {
    databasePath: path.join(root, 'data.sqlite'),
    sessionDays: 30,
    bootstrapAdminUsername: 'admin',
    bootstrapAdminPassword: 'admin-password-123'
  }
  const db = new PlatformDb(config)
  return { db, close: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}

function cloudStoreToken (payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function freePort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function httpJson (port, pathname, token = '') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers: token ? { authorization: `Bearer ${token}` } : {} }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(value)
          else reject(new Error(value.error || `HTTP ${res.statusCode}`))
        } catch (error) { reject(error) }
      })
    })
    req.setTimeout(1000, () => req.destroy(new Error('request timeout')))
    req.on('error', reject)
  })
}

async function waitFor (probe, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try { return await probe() } catch (error) { lastError = error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw lastError || new Error('timed out')
}

function waitForExit (child, timeoutMs = 5000) {
  if (child.exitCode !== null) return Promise.resolve()
  return Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('process did not exit')), timeoutMs))
  ])
}

test('users authenticate and sessions resolve', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('player_one', 'password-123')
    assert.equal(f.db.authenticate('player_one', 'password-123').id, user.id)
    const session = f.db.createSession(user.id)
    assert.equal(f.db.getSessionUser(session.token).username, 'player_one')
  } finally { f.close() }
})

test('users can change their own password only with the current password', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('password_owner', 'password-123')
    const session = f.db.createSession(user.id)
    assert.throws(() => f.db.changeUserPassword(user.id, 'wrong-password', 'new-password-456'), /当前密码不正确/)
    assert.equal(f.db.getSessionUser(session.token).id, user.id)
    assert.equal(f.db.changeUserPassword(user.id, 'password-123', 'new-password-456'), true)
    assert.equal(f.db.authenticate('password_owner', 'password-123'), null)
    assert.equal(f.db.authenticate('password_owner', 'new-password-456').id, user.id)
    assert.equal(f.db.getSessionUser(session.token), null)
  } finally { f.close() }
})

test('cloud store identities use player names without local passwords', () => {
  const f = fixture()
  try {
    assert.equal(f.db.getRegistrationEnabled(), false)
    const admin = f.db.upsertCloudStoreUser('uuid-damomo', 'Damomo1', 'Damomo1')
    const player = f.db.upsertCloudStoreUser('uuid-player', 'PlayerOne', 'Damomo1')
    assert.equal(admin.role, 'admin')
    assert.equal(admin.authSource, 'cloud_store')
    assert.equal(player.role, 'user')
    assert.equal(f.db.authenticate('Damomo1', 'anything'), null)
    assert.throws(() => f.db.changeUserPassword(admin.id, 'anything', 'password-123'), /不使用本地密码/)
    assert.equal(f.db.upsertCloudStoreUser('uuid-player', 'PlayerRenamed', 'Damomo1').id, player.id)
    assert.equal(f.db.getUser(player.id).username, 'PlayerRenamed')
    assert.equal(f.db.addPlatformAdmin('PlayerRenamed').role, 'admin')
    assert.equal(f.db.upsertCloudStoreUser('uuid-player', 'PlayerRenamed', 'Damomo1').role, 'admin')
    assert.throws(() => f.db.removePlatformAdmin(admin.id, { actorUserId: player.id, rootUsername: 'Damomo1' }), /根管理员/)
    assert.throws(() => f.db.removePlatformAdmin(player.id, { actorUserId: player.id, rootUsername: 'Damomo1' }), /当前登录账号/)
    assert.equal(f.db.removePlatformAdmin(player.id, { actorUserId: admin.id, rootUsername: 'Damomo1' }).role, 'user')
    assert.equal(f.db.setRegistrationEnabled(true), true)
  } finally { f.close() }
})

test('Bot platform verifies signed, expiring cloud store tokens', () => {
  const secret = 'k'.repeat(64)
  const payload = { iss: 'cloud-store', sub: 'uuid-player', username: 'PlayerOne', iat: 1000, exp: 61000, nonce: 'nonce-1' }
  assert.deepEqual(verifyCloudStoreToken(cloudStoreToken(payload, secret), secret, { now: 2000 }), {
    externalId: 'uuid-player',
    username: 'PlayerOne',
    expiresAt: 61000,
    nonce: 'nonce-1'
  })
  assert.throws(() => verifyCloudStoreToken(cloudStoreToken(payload, secret), secret, { now: 62000 }), /已过期/)
  assert.throws(() => verifyCloudStoreToken(cloudStoreToken(payload, 'x'.repeat(64)), secret, { now: 2000 }), /签名无效/)
})

test('legacy admin account migrates to the cloud store Damomo1 identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-admin-migration-'))
  const config = { databasePath: path.join(root, 'data.sqlite'), sessionDays: 30, cloudStoreAdminUsername: 'Damomo1' }
  let db = new PlatformDb(config)
  try {
    const legacy = db.createUser('admin', 'admin-password-123', 'admin')
    db.close()
    db = new PlatformDb(config)
    const migrated = db.db.prepare('SELECT id, username, role, auth_source AS authSource FROM users WHERE id = ?').get(legacy.id)
    assert.deepEqual(migrated, { id: legacy.id, username: 'Damomo1', role: 'admin', authSource: 'cloud_store' })
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('momoc billing is atomic and cannot go negative', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('player_two', 'password-123')
    f.db.adjustMomoc(user.id, 2, 'admin_adjust')
    const bot = f.db.createBot(user.id, { templateId: 'idle-login', label: 'Idle', microsoftEmail: 'bot@example.com', serverHost: 'localhost', serverPort: 25565 })
    assert.equal(f.db.chargeHourlyMinute(bot.id, 60).ok, true)
    assert.equal(f.db.chargeHourlyMinute(bot.id, 60).ok, true)
    assert.equal(f.db.chargeHourlyMinute(bot.id, 60).ok, false)
    assert.equal(f.db.getUser(user.id).momoc, 0)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS count FROM momoc_ledger WHERE kind = 'bot_hourly'").get().count, 1)
    const usage = f.db.listLedger(user.id).find(row => row.kind === 'bot_usage')
    assert.equal(usage.minutes, 2)
    assert.equal(usage.delta, -2)
    assert.equal(usage.balanceAfter, 0)
  } finally { f.close() }
})

test('core bot hourly price is deducted precisely once per minute', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('player_hourly', 'password-123')
    f.db.adjustMomoc(user.id, 0.03, 'admin_adjust')
    const bot = f.db.createBot(user.id, { templateId: 'idle-login', label: 'Hourly', microsoftEmail: 'bot@example.com', serverHost: 'localhost' })
    assert.equal(f.db.chargeHourlyMinute(bot.id, 0.03).ok, true)
    assert.equal(f.db.getUser(user.id).momoc, 0.0295)
    for (let minute = 1; minute < 60; minute++) assert.equal(f.db.chargeHourlyMinute(bot.id, 0.03).ok, true)
    assert.equal(f.db.getUser(user.id).momoc, 0)
    const usage = f.db.listLedger(user.id).find(row => row.kind === 'bot_usage')
    assert.equal(usage.minutes, 60)
    assert.equal(usage.delta, -0.03)
  } finally { f.close() }
})

test('bots no longer store or depend on a template id', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('player_three', 'password-123')
    f.db.createBot(user.id, { label: 'Idle', microsoftEmail: 'bot@example.com', serverHost: 'localhost' })
    const columns = f.db.db.prepare('PRAGMA table_info(bots)').all().map(row => row.name)
    assert.equal(columns.includes('template_id'), false)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='bot_templates'").get().count, 0)
  } finally { f.close() }
})

test('module variables are normalized, validated and exposed as environment values', () => {
  const definitions = normalizeDefinitions([
    { key: 'join_message', label: '进服消息', type: 'text', required: true, maxLength: 32 },
    { key: 'repeat_count', label: '次数', type: 'number', default: 2, min: 1, max: 5 },
    { key: 'enabled', label: '启用', type: 'boolean', default: true },
    { key: 'mode', label: '模式', type: 'select', options: ['chat', 'command'] }
  ])
  const values = validateValues(definitions, { join_message: 'bot plat..test', repeat_count: '3', enabled: false, mode: 'command' })
  assert.deepEqual(values, { join_message: 'bot plat..test', repeat_count: 3, enabled: false, mode: 'command' })
  const env = environmentForValues(values)
  assert.equal(JSON.parse(env.BOT_PLATFORM_VARIABLES).join_message, 'bot plat..test')
  assert.equal(env.BOT_TEMPLATE_JOIN_MESSAGE, 'bot plat..test')
  assert.throws(() => validateValues(definitions, { join_message: '' }), /不能为空/)
  assert.throws(() => validateValues(definitions, { join_message: 'ok', unknown: 'x' }), /没有声明变量/)
})

test('users can own multiple Microsoft accounts and bots reference an account', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('account_owner', 'password-123')
    const first = f.db.createMicrosoftAccount(user.id, 'first@example.com')
    const second = f.db.createMicrosoftAccount(user.id, 'second@example.com')
    f.db.updateMicrosoftAccountAuth(first.id, { authState: 'authorized', minecraftName: 'FirstBot' })
    f.db.updateMicrosoftAccountAuth(second.id, { authState: 'authorized', minecraftName: 'SecondBot' })
    assert.equal(f.db.listMicrosoftAccounts(user.id).length, 2)
    const bot = f.db.createBot(user.id, { accountId: first.id, templateId: 'idle-login', label: 'Uses First', serverHost: 'localhost' })
    assert.equal(bot.accountId, first.id)
    assert.equal(bot.microsoftEmail, 'first@example.com')
  } finally { f.close() }
})

test('one Microsoft account cannot run two core bot processes at once', async () => {
  const bots = {
    first: { id: 'first', userId: 'user', accountId: 'account', accountAuthState: 'authorized', billingMode: 'hourly', priceMomoc: 0 },
    second: { id: 'second', userId: 'user', accountId: 'account', accountAuthState: 'authorized', billingMode: 'hourly', priceMomoc: 0 }
  }
  const db = {
    getBot: id => bots[id],
    getUser: () => ({ availableMomoc: 1 }),
    getModePrices: () => ({ smartHourlyPrice: 0.03, signinOncePrice: 0.01 }),
    updateBotRuntime: () => {}
  }
  const manager = new BotManager(db, {})
  manager.launchAttempt = () => {}
  await manager.start('first')
  await assert.rejects(manager.start('second'), /已有其他模板正在运行/)
})

test('platform runtime settings persist and admin overview exposes configured prefixes and AFK locks', () => {
  const f = fixture()
  try {
    assert.deepEqual(f.db.getRuntimeSettings(), { maxRunningBots: 0, botCreationEnabled: true })
    assert.deepEqual(f.db.setRuntimeSettings({ maxRunningBots: 12, botCreationEnabled: false }), { maxRunningBots: 12, botCreationEnabled: false })
    const user = f.db.createUser('runtime_settings_owner', 'password-123')
    const bot = f.db.createBot(user.id, { mode: 'smart', label: 'AFK', microsoftEmail: 'afk@example.com', serverHost: 'localhost' })
    f.db.setSmartBotSettings(bot.id, { commandPrefix: 'afk!' })
    f.db.setSmartBotLock(bot.id, { locked: true, lockedBy: 'PlayerOne', reason: 'farming' })
    const overviewBot = f.db.adminOverview().bots.find(row => row.id === bot.id)
    assert.equal(overviewBot.commandPrefix, 'afk!')
    assert.equal(overviewBot.afkLocked, true)
    assert.equal(overviewBot.lock.lockedBy, 'PlayerOne')
    assert.equal(Object.hasOwn(overviewBot, 'botName'), false)
  } finally { f.close() }
})

test('smart running limit does not apply to signin bots', async () => {
  const rows = {
    running: { id: 'running', userId: 'user', accountId: 'account-1', accountAuthState: 'authorized', mode: 'smart' },
    smart: { id: 'smart', userId: 'user', accountId: 'account-2', accountAuthState: 'authorized', mode: 'smart' },
    signin: { id: 'signin', userId: 'user', accountId: 'account-3', accountAuthState: 'authorized', mode: 'signin' }
  }
  const db = {
    getBot: id => rows[id],
    getUser: () => ({ availableMomoc: 1 }),
    getModePrices: () => ({ smartHourlyPrice: 0.03, signinOncePrice: 0.01 }),
    getRuntimeSettings: () => ({ maxRunningBots: 1, botCreationEnabled: true }),
    reserveOnce: () => ({ ok: true }),
    updateBotRuntime: () => {}
  }
  const manager = new BotManager(db, {})
  manager.processes.set('running', {})
  manager.launchAttempt = () => {}
  await assert.rejects(manager.start('smart'), /达到上限/)
  await assert.doesNotReject(manager.start('signin'))
})

test('web platform restarts reconnect to the same persistent bot supervisor', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-supervisor-'))
  const platformPort = await freePort()
  const supervisorPort = await freePort()
  const secretFile = path.join(root, 'supervisor.key')
  const env = {
    ...process.env,
    BOT_PLATFORM_PORT: String(platformPort),
    BOT_PLATFORM_SUPERVISOR_PORT: String(supervisorPort),
    BOT_PLATFORM_DATABASE_PATH: path.join(root, 'platform.sqlite'),
    BOT_PLATFORM_AUTH_CACHE_ROOT: path.join(root, 'auth-cache'),
    BOT_PLATFORM_SUPERVISOR_SECRET_FILE: secretFile
  }
  const launch = () => spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env,
    windowsHide: true,
    stdio: 'ignore'
  })

  let first
  let second
  let supervisorPid
  try {
    first = launch()
    await waitFor(() => httpJson(platformPort, '/api/health'))
    const token = fs.readFileSync(secretFile, 'utf8').trim()
    const initial = await waitFor(() => httpJson(supervisorPort, '/health', token))
    supervisorPid = initial.pid

    first.kill('SIGTERM')
    await waitForExit(first)
    assert.equal((await httpJson(supervisorPort, '/health', token)).pid, supervisorPid)

    second = launch()
    await waitFor(() => httpJson(platformPort, '/api/health'))
    assert.equal((await httpJson(supervisorPort, '/health', token)).pid, supervisorPid)
  } finally {
    for (const child of [first, second]) {
      if (!child || child.exitCode !== null) continue
      child.kill('SIGTERM')
      await waitForExit(child).catch(() => {
        if (process.platform === 'win32') {
          try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
        }
      })
    }
    if (supervisorPid) {
      try { process.kill(supervisorPid, 'SIGTERM') } catch {}
      await waitFor(async () => {
        try { await httpJson(supervisorPort, '/health', fs.readFileSync(secretFile, 'utf8').trim()); throw new Error('still running') } catch (error) {
          if (error.message === 'still running') throw error
          return true
        }
      }).catch(() => {})
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('bot runtime logs stay in memory and retain only the latest fifty entries', () => {
  const manager = new BotManager({ getModePrices: () => ({ smartHourlyPrice: 0.03, signinOncePrice: 0.01 }) }, {})
  for (let index = 0; index < 52; index++) manager.appendLog('bot-log-test', 'info', `line ${index}`)
  const logs = manager.listLogs('bot-log-test')
  assert.equal(logs.length, 50)
  assert.equal(logs[0].message, 'line 2')
  assert.equal(logs.at(-1).message, 'line 51')
  logs[0].message = 'changed by caller'
  assert.equal(manager.listLogs('bot-log-test')[0].message, 'line 2')
  manager.appendLog('bot-log-secret', 'stdout', '{"access_token":"secret-token", "user_code":"device-code"} Authorization: bearer-token')
  const redacted = manager.listLogs('bot-log-secret')[0].message
  assert.doesNotMatch(redacted, /secret-token|device-code|bearer-token/)
  assert.match(redacted, /\[redacted\]/)
  manager.appendLog('bot-log-test', 'stdout', '[message:public] Player: unrelated server chat')
  assert.equal(manager.listLogs('bot-log-test').some(entry => entry.message.includes('unrelated server chat')), false)
  const bot = manager.publicBot({ id: 'bot-log-test', mode: 'smart', oauthJson: '', templateVarsJson: '' })
  assert.equal(bot.logs.length, 50)
})

test('dismount uses the Minecraft sneak control and releases it after leaving the vehicle', async () => {
  const controls = []
  const bot = {
    vehicle: { name: 'minecart' },
    setControlState: (control, active) => {
      controls.push([control, active])
      if (control === 'sneak' && active) bot.vehicle = null
    }
  }
  assert.deepEqual(await dismountVehicle(bot), { status: 'dismounted' })
  assert.deepEqual(controls, [['sneak', true], ['sneak', false]])
})

test('admin overview aggregates accounts, bots and precise user consumption', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('overview_user', 'password-123')
    f.db.adjustMomoc(user.id, 3, 'admin_adjust')
    const account = f.db.createMicrosoftAccount(user.id, 'overview@example.com')
    f.db.updateMicrosoftAccountAuth(account.id, { authState: 'authorized', minecraftName: 'OverviewBot' })
    const bot = f.db.createBot(user.id, { accountId: account.id, templateId: 'idle-login', label: 'Overview', serverHost: 'localhost' })
    assert.equal(f.db.chargeHourlyMinute(bot.id, 0.03).ok, true)
    const overview = f.db.adminOverview()
    const accountRow = overview.accounts.find(row => row.id === account.id)
    const userRow = overview.consumption.find(row => row.userId === user.id)
    assert.equal(overview.stats.authorizedAccounts, 1)
    assert.equal(overview.stats.bots, 1)
    assert.equal(accountRow.botCount, 1)
    assert.deepEqual(accountRow.templateNames, [])
    assert.equal(userRow.hourlySpent, 0.0005)
    assert.equal(userRow.totalSpent, 0.0005)
    assert.equal(userRow.billedMinutes, 1)
  } finally { f.close() }
})

test('zenox chat parser normalizes custom public and private messages and deduplicates packets', () => {
  const bot = new EventEmitter()
  bot.username = 'PlatformBot'
  bot.players = { PlatformBot: { uuid: 'bot-uuid' }, PlayerOne: { uuid: 'player-uuid' } }
  bot._client = new EventEmitter()
  installZenoxChatParser(bot)
  const rows = []
  bot.on('botPlatformMessage', row => rows.push(row))
  bot.emit('messagestr', '[VIP] PlayerOne » !test喵~', 'chat', null, null)
  bot._client.emit('player_chat', { senderUuid: 'player-uuid', plainMessage: '!test' })
  bot.emit('messagestr', '[PlayerOne ➥ PlatformBot] private text', 'system', null, null)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { username: 'PlayerOne', message: '!test', channel: 'public', source: 'messagestr' })
  assert.deepEqual(rows[1], { username: 'PlayerOne', message: 'private text', channel: 'private', source: 'messagestr' })
})

test('server chat normalization removes every cat suffix before command parsing', () => {
  assert.equal(normalizeServerChatText('难道是爱而不得喵~'), '难道是爱而不得')
  assert.equal(normalizeServerChatText('命令喵~ 参数喵～'), '命令 参数')
  assert.deepEqual(parseSmartCommand('PlatformBot定期右键 100 64 200 20喵~', ['PlatformBot']), {
    prefix: 'PlatformBot',
    command: '定期右键',
    args: ['100', '64', '200', '20'],
    body: '定期右键 100 64 200 20'
  })
})

test('zenox chat parser emits deduplicated TSL teleport requests', () => {
  const bot = new EventEmitter()
  bot.username = 'PlatformBot'
  bot.players = { PlatformBot: { uuid: 'bot-uuid' } }
  bot._client = new EventEmitter()
  installZenoxChatParser(bot)
  const rows = []
  bot.on('botPlatformTeleportRequest', row => rows.push(row))
  const toRequester = '[TSL] NanKinz2 \u8bf7\u6c42\u4f60\u4f20\u9001\u5230\u4ed6\u7684\u4f4d\u7f6e\u3002(60 \u79d2\u5185\u6709\u6548) [\u63a5\u53d7] [\u62d2\u7edd]'
  const toBot = '[TSL] WhiteOne \u8bf7\u6c42\u4f20\u9001\u5230\u4f60\u7684\u4f4d\u7f6e\u3002(60 \u79d2\u5185\u6709\u6548) [\u63a5\u53d7] [\u62d2\u7edd]'
  bot._client.emit('system_chat', { content: toRequester, isActionBar: false })
  bot.emit('messagestr', toRequester, 'system', null, null)
  bot._client.emit('system_chat', { content: toBot, isActionBar: false })
  assert.deepEqual(rows, [
    { username: 'NanKinz2', kind: 'to_requester', source: 'system_chat' },
    { username: 'WhiteOne', kind: 'to_bot', source: 'system_chat' }
  ])
})

test('smart teleport acceptance permits a locked bot to receive whitelisted players', async () => {
  const bot = new EventEmitter()
  bot.username = 'PlatformBot'
  const chats = []
  bot.chat = message => chats.push(message)
  let lock = { locked: false }
  const access = {
    WhiteOne: { whitelisted: true, blacklisted: false },
    BannedOne: { whitelisted: true, blacklisted: true },
    GuestOne: { whitelisted: false, blacklisted: false }
  }
  const handler = createTeleportRequestHandler(bot, {
    platform: {
      request: async (action, payload) => {
        assert.equal(action, 'access')
        return { ...(access[payload.username] || access.GuestOne), lock }
      }
    }
  })
  await handler({ username: 'WhiteOne', kind: 'to_bot' })
  await handler({ username: 'BannedOne', kind: 'to_bot' })
  await handler({ username: 'GuestOne', kind: 'to_bot' })
  lock = { locked: true }
  await handler({ username: 'WhiteOne', kind: 'to_requester' })
  await handler({ username: 'WhiteOne', kind: 'to_bot' })
  assert.deepEqual(chats, ['/tpaccept WhiteOne', '/tpaccept WhiteOne'])
})

test('player right click mirrors a look, swing, and ordinary entity interaction', async () => {
  const target = { type: 'player', username: 'WhiteOne', position: { offset: (x, y, z) => ({ x, y, z }) } }
  const calls = []
  const bot = {
    entities: { 1: target },
    entity: { position: { distanceTo: () => 3 } },
    lookAt: async (point, force) => calls.push({ type: 'look', point, force }),
    swingArm: hand => calls.push({ type: 'swing', hand }),
    activateEntity: async entity => calls.push({ type: 'interact', entity })
  }
  await rightClickTarget(bot, ['whiteone'])
  assert.deepEqual(calls, [
    { type: 'look', point: { x: 0, y: 1, z: 0 }, force: true },
    { type: 'swing', hand: 'right' },
    { type: 'interact', entity: target }
  ])
  bot.entity.position.distanceTo = () => 5
  await assert.rejects(() => rightClickTarget(bot, ['WhiteOne']), /out of reach/)
})

test('platform creates only smart and signin bot modes', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('mode_user', 'password-123')
    const smart = f.db.createBot(user.id, { mode: 'smart', label: 'Smart', microsoftEmail: 'smart@example.com', serverHost: 'localhost' })
    const signin = f.db.createBot(user.id, { mode: 'signin', label: 'Signin', microsoftEmail: 'signin@example.com', serverHost: 'localhost' })
    assert.equal(smart.mode, 'smart')
    assert.equal(signin.mode, 'signin')
    assert.deepEqual(signin.modeVariables, {})
  } finally { f.close() }
})

test('smart permissions are tenant isolated, expire, and persist with bot locks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-smart-'))
  const config = {
    databasePath: path.join(root, 'data.sqlite'),
    sessionDays: 30,
    bootstrapAdminUsername: 'admin',
    bootstrapAdminPassword: 'admin-password-123'
  }
  let db = new PlatformDb(config)
  try {
    const first = db.createUser('smart_owner_one', 'password-123')
    const second = db.createUser('smart_owner_two', 'password-123')
    const bot = db.createBot(first.id, { mode: 'smart', label: 'Smart', microsoftEmail: 'smart@example.com', serverHost: 'localhost' })
    db.setSmartPermission(first.id, 'Alice', 'admin', { createdBy: 'web' })
    db.setSmartPermission(first.id, 'TempPlayer', 'whitelist', { expiresAt: Date.now() + 1000, createdBy: 'Alice' })
    db.setSmartBotLock(bot.id, { locked: true, adminLocked: true, lockedBy: 'Alice', reason: 'maintenance' })
    const longPrefix = `prefix-${'x'.repeat(300)}!`
    db.setSmartBotSettings(bot.id, { commandPrefix: longPrefix })
    const otherBot = db.createBot(second.id, { mode: 'smart', label: 'Other Smart', microsoftEmail: 'other-smart@example.com', serverHost: 'localhost' })
    assert.throws(() => db.setSmartBotSettings(otherBot.id, { commandPrefix: longPrefix.toUpperCase() }), /已被其他 Bot 使用/)
    db.setSmartBotSettings(otherBot.id, { commandPrefix: 'other-prefix!' })
    assert.throws(() => db.setSmartBotSettings(otherBot.id, { commandPrefix: '123' }), /特殊符号结尾/)
    assert.throws(() => db.setSmartBotSettings(otherBot.id, { commandPrefix: '@n' }), /特殊符号结尾/)

    assert.equal(db.getSmartAccess(first.id, 'alice').admin, true)
    assert.equal(db.getSmartAccess(first.id, 'ALICE').whitelisted, true)
    assert.equal(db.getSmartAccess(second.id, 'Alice').admin, false)
    assert.equal(db.getSmartAccess(first.id, 'TempPlayer', Date.now() + 2000).whitelisted, false)

    db.close()
    db = new PlatformDb(config)
    assert.equal(db.getSmartAccess(first.id, 'Alice').admin, true)
    assert.equal(db.getSmartBotSettings(bot.id).commandPrefix, longPrefix)
    assert.equal(db.getSmartBotSettings(otherBot.id).commandPrefix, 'other-prefix!')
    assert.deepEqual(db.listSmartBotPrefixes(second.id).map(row => [row.id, row.commandPrefix]), [[otherBot.id, 'other-prefix!']])
    assert.deepEqual(db.getSmartBotLock(bot.id), {
      locked: true,
      adminLocked: true,
      lockedBy: 'Alice',
      reason: 'maintenance',
      updatedAt: db.getSmartBotLock(bot.id).updatedAt
    })
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('smart ominous bottle schedule persists its enabled state and next due time', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-ominous-'))
  const config = {
    databasePath: path.join(root, 'data.sqlite'),
    sessionDays: 30,
    bootstrapAdminUsername: 'admin',
    bootstrapAdminPassword: 'admin-password-123'
  }
  let db = new PlatformDb(config)
  try {
    const user = db.createUser('ominous_owner', 'password-123')
    const bot = db.createBot(user.id, { mode: 'smart', label: 'Smart', microsoftEmail: 'ominous@example.com', serverHost: 'localhost' })
    const enabled = db.setSmartBotOminousBottle(bot.id, true, { now: 1000, intervalMilliseconds: 31000 })
    assert.equal(enabled.ominousBottleEnabled, true)
    assert.equal(enabled.ominousBottleNextDueAt, 1000)

    db.close()
    db = new PlatformDb(config)
    assert.equal(db.getSmartBotAutomation(bot.id).ominousBottleNextDueAt, 1000)
    const completed = db.completeSmartBotOminousBottle(bot.id, { now: 5000, intervalMilliseconds: 31000 })
    assert.equal(completed.ominousBottleLastUsedAt, 5000)
    assert.equal(completed.ominousBottleNextDueAt, 36000)
    assert.equal(db.setSmartBotOminousBottle(bot.id, false).ominousBottleEnabled, false)
    assert.equal(db.getSmartBotAutomation(bot.id).ominousBottleNextDueAt, null)
    const reenabled = db.setSmartBotOminousBottle(bot.id, true, { now: 8000, intervalMilliseconds: 31000 })
    assert.equal(reenabled.ominousBottleEnabled, true)
    assert.equal(reenabled.ominousBottleNextDueAt, 8000)
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('periodic right click settings persist direct target coordinates and game-tick interval', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-right-click-'))
  const config = { databasePath: path.join(root, 'data.sqlite'), sessionDays: 30 }
  let db = new PlatformDb(config)
  try {
    const user = db.createUser('right_click_owner', 'password-123')
    const bot = db.createBot(user.id, { mode: 'smart', label: 'Builder', microsoftEmail: 'builder@example.com', serverHost: 'localhost' })
    const enabled = db.setSmartBotPeriodicRightClick(bot.id, { enabled: true, x: 100, y: 64, z: -200, intervalTicks: 20 }, { now: 1000 })
    assert.equal(enabled.periodicRightClickEnabled, true)
    assert.deepEqual([enabled.periodicRightClickX, enabled.periodicRightClickY, enabled.periodicRightClickZ], [100, 64, -200])
    assert.equal(enabled.periodicRightClickNextDueAt, 2000)

    db.close()
    db = new PlatformDb(config)
    const persisted = db.getSmartBotAutomation(bot.id)
    assert.equal(persisted.periodicRightClickIntervalTicks, 20)
    assert.equal(persisted.periodicRightClickNextDueAt, 2000)
    const completed = db.completeSmartBotPeriodicRightClick(bot.id, { now: 3000 })
    assert.equal(completed.periodicRightClickLastRunAt, 3000)
    assert.equal(completed.periodicRightClickNextDueAt, 4000)
    assert.equal(db.setSmartBotPeriodicRightClick(bot.id, { enabled: false }).periodicRightClickEnabled, false)
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('periodic right click parser uses direct coordinates without direction suffixes', () => {
  assert.deepEqual(parsePeriodicRightClickArgs(['100', '64', '-200', '20']), { x: 100, y: 64, z: -200, intervalTicks: 20 })
  assert.equal(parsePeriodicRightClickArgs(['100', '64+', '200', '20']), null)
  assert.equal(parsePeriodicRightClickArgs(['100', '64', '200', '0']), null)
})

test('periodic right click places at the exact target using an automatically selected neighbor', async () => {
  const placed = []
  const bot = {
    entity: {},
    heldItem: { name: 'oak_sapling' },
    blockAt: position => position.x === 100 && position.y === 63 && position.z === 200
      ? { name: 'dirt', boundingBox: 'block', position }
      : { name: 'air', boundingBox: 'empty', position },
    placeBlock: async (reference, face) => placed.push({ reference: reference.position, face })
  }
  await placePeriodicRightClick(bot, { periodicRightClickX: 100, periodicRightClickY: 64, periodicRightClickZ: 200 })
  assert.deepEqual({ x: placed[0].reference.x, y: placed[0].reference.y, z: placed[0].reference.z }, { x: 100, y: 63, z: 200 })
  assert.deepEqual({ x: placed[0].face.x, y: placed[0].face.y, z: placed[0].face.z }, { x: 0, y: 1, z: 0 })
})

test('ominous bottle scheduler records only successful drinks', async () => {
  const requests = []
  let drinks = 0
  const timers = []
  const platform = {
    request: async action => {
      requests.push(action)
      if (action === 'ominous_schedule_get') return { ominousBottleEnabled: true, ominousBottleNextDueAt: 1000 }
      if (action === 'ominous_schedule_complete') return { ominousBottleEnabled: true, ominousBottleNextDueAt: 2000 }
      throw new Error(`unexpected action ${action}`)
    }
  }
  const scheduler = createOminousBottleScheduler({}, {
    platform,
    now: () => 1000,
    drinkOminousBottle: async () => { drinks += 1 },
    setTimer: (handler, milliseconds) => { timers.push({ handler, milliseconds }); return { unref () {} } },
    clearTimer: () => {},
    logger: { log () {}, warn () {} }
  })
  await scheduler.start()
  assert.equal(timers.at(-1).milliseconds, 0)
  await scheduler.runNow()
  assert.equal(drinks, 1)
  assert.equal(requests.filter(action => action === 'ominous_schedule_complete').length, 1)
  assert.equal(scheduler.getSettings().ominousBottleNextDueAt, 2000)
  scheduler.stop()
})

test('periodic right click scheduler advances after each placement attempt', async () => {
  const requests = []
  const timers = []
  let placements = 0
  const settings = {
    periodicRightClickEnabled: true,
    periodicRightClickX: 100,
    periodicRightClickY: 64,
    periodicRightClickZ: 200,
    periodicRightClickIntervalTicks: 20,
    periodicRightClickNextDueAt: 2000
  }
  const scheduler = createPeriodicRightClickScheduler({}, {
    platform: {
      request: async action => {
        requests.push(action)
        if (action === 'periodic_right_click_get') return settings
        if (action === 'periodic_right_click_complete') return { ...settings, periodicRightClickLastRunAt: 2000, periodicRightClickNextDueAt: 3000 }
        throw new Error(`unexpected action ${action}`)
      }
    },
    now: () => 1000,
    placePeriodicRightClick: async () => { placements += 1 },
    setTimer: (handler, milliseconds) => { timers.push({ handler, milliseconds }); return { unref () {} } },
    clearTimer: () => {},
    logger: { warn () {} }
  })
  await scheduler.start()
  assert.equal(timers.at(-1).milliseconds, 1000)
  await scheduler.runNow()
  assert.equal(placements, 1)
  assert.deepEqual(requests, ['periodic_right_click_get', 'periodic_right_click_complete'])
  assert.equal(scheduler.getSettings().periodicRightClickNextDueAt, 3000)
  scheduler.stop()
})

test('smart command database requests recheck roles before mutations', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('smart_request_owner', 'password-123')
    const bot = f.db.createBot(user.id, { mode: 'smart', label: 'Smart', microsoftEmail: 'request@example.com', serverHost: 'localhost' })
    f.db.setSmartPermission(user.id, 'RootPlayer', 'admin')
    const manager = new BotManager(f.db, {})
    const sent = []
    manager.processes.set(bot.id, { child: { send: message => sent.push(message) } })
    f.db.setSmartBotSettings(bot.id, { commandPrefix: 'very-long-custom-prefix!' })
    assert.equal(manager.executeSmartRequest(bot.id, 'settings', {}).commandPrefix, 'very-long-custom-prefix!')
    manager.syncSmartSettings(bot.id)
    assert.deepEqual(sent.pop(), { type: 'smart_settings', settings: f.db.getSmartBotSettings(bot.id) })

    assert.equal(manager.executeSmartRequest(bot.id, 'permission_add', { username: 'Guest', target: 'Alice', role: 'whitelist' }).allowed, false)
    assert.equal(manager.executeSmartRequest(bot.id, 'permission_add', { username: 'RootPlayer', target: 'Alice', role: 'whitelist' }).added, true)
    assert.equal(f.db.getSmartAccess(user.id, 'Alice').whitelisted, true)

    const periodic = manager.executeSmartRequest(bot.id, 'periodic_right_click_set', { username: 'Alice', enabled: true, x: 100, y: 64, z: 200, intervalTicks: 20 })
    assert.equal(periodic.allowed, true)
    assert.equal(periodic.settings.periodicRightClickX, 100)
    assert.equal(manager.executeSmartRequest(bot.id, 'periodic_right_click_get', {}).periodicRightClickIntervalTicks, 20)

    f.db.setSmartBotTask(bot.id, { name: 'scheduled', steps: [{ type: 'command', command: '切换', args: ['1'] }] })
    f.db.scheduleSmartBotTask(bot.id, 'scheduled', 20)
    const rescheduled = manager.executeSmartRequest(bot.id, 'task_schedule_complete', { name: 'scheduled' })
    assert.equal(rescheduled.task.intervalTicks, 20)

    const ominous = manager.executeSmartRequest(bot.id, 'ominous_schedule_set', { username: 'Alice', enabled: true })
    assert.equal(ominous.allowed, true)
    assert.equal(manager.list(user.id)[0].smartSchedules.automation.ominousBottleEnabled, true)

    const lock = manager.executeSmartRequest(bot.id, 'lock_set', { username: 'Alice', level: 'normal', locked: true, reason: 'afk' })
    assert.equal(lock.status, 'locked')
    assert.equal(lock.lock.reason, 'afk')
    const superLock = manager.executeSmartRequest(bot.id, 'lock_set', { username: 'RootPlayer', level: 'admin', locked: true, reason: 'admin' })
    assert.equal(superLock.lock.adminLocked, true)
    assert.equal(manager.executeSmartRequest(bot.id, 'lock_set', { username: 'Alice', level: 'normal', locked: false }).status, 'admin_locked')
    const superUnlock = manager.executeSmartRequest(bot.id, 'lock_set', { username: 'RootPlayer', level: 'admin', locked: false })
    assert.equal(superUnlock.status, 'unlocked')
    assert.deepEqual(superUnlock.lock, { locked: false, adminLocked: false, lockedBy: '', reason: '', updatedAt: superUnlock.lock.updatedAt })
    assert.equal(manager.executeSmartRequest(bot.id, 'lock_set', { username: 'Alice', level: 'normal', locked: false }).status, 'missing')
  } finally { f.close() }
})

test('smart command handler enforces prefixes, access, locks, forwarding, and map lookup', async () => {
  assert.deepEqual(parseSmartCommand('NanKinz2查白 Alice', ['NanKinz2']), { prefix: 'NanKinz2', command: '查白', args: ['Alice'], body: '查白 Alice' })
  assert.equal(parseSmartCommand('查白 Alice', ['NanKinz2']), null)

  const bot = new EventEmitter()
  bot.username = 'PlatformBot'
  bot.entity = { position: { distanceTo: () => 2 } }
  const chats = []
  bot.chat = message => chats.push(message)
  const minecart = { name: 'minecart', position: {} }
  bot.nearestEntity = predicate => predicate(minecart) ? minecart : null
  bot.mount = entity => { bot.vehicle = entity }
  bot.dismount = () => { bot.vehicle = null }
  let inventoryItems = [{ name: 'stone', count: 32, slot: 9 }, { name: 'dirt', count: 5, slot: 10 }]
  bot.inventory = { items: () => inventoryItems }
  bot.tossStack = async item => { inventoryItems = inventoryItems.filter(row => row !== item) }
  let quickBarSlot = -1
  bot.setQuickBarSlot = slot => { quickBarSlot = slot }
  let lock = { locked: false, adminLocked: false, lockedBy: '', reason: '' }
  const access = {
    Guest: { blacklisted: false, whitelisted: false, admin: false },
    White: { blacklisted: false, whitelisted: true, admin: false },
    Root: { blacklisted: false, whitelisted: true, admin: true },
    Banned: { blacklisted: true, whitelisted: false, admin: false }
  }
  const requests = []
  let ominousSettings = { ominousBottleEnabled: false, ominousBottleLastUsedAt: null, ominousBottleNextDueAt: null }
  let periodicSettings = { periodicRightClickEnabled: false, periodicRightClickX: null, periodicRightClickY: null, periodicRightClickZ: null, periodicRightClickIntervalTicks: 20, periodicRightClickNextDueAt: null }
  let mapFetches = 0
  let mapUrl = ''
  const mapPlayers = [
    { name: 'Guest', world: 'world', position: { x: 0, z: 0 } },
    { name: 'White', world: 'world', position: { x: 3, z: 0 } },
    { name: 'Root', world: 'world', position: { x: 0, z: 4 } },
    { name: 'Third', world: 'world', position: { x: 0, z: 6 } },
    { name: 'Target', world: 'world', position: { x: 10.9, z: 0 } },
    { name: 'Banned', world: 'world', position: { x: 100, z: 0 } },
    { name: 'NetherClose', world: 'world_nether', position: { x: 10, z: 0 } },
    { name: 'EndPlayer', world: 'world_the_end', position: { x: 11, z: 0 } }
  ]
  const platform = {
    request: async (action, payload) => {
      requests.push({ action, payload })
      if (action === 'access') return { ...(access[payload.username] || access.Guest), lock }
      if (action === 'permission_query') return { allowed: true, exists: payload.target === 'White', permission: null }
      if (action === 'permission_add') return { allowed: true, added: true }
      if (action === 'ominous_schedule_get') return ominousSettings
      if (action === 'ominous_schedule_set') {
        ominousSettings = {
          ...ominousSettings,
          ominousBottleEnabled: payload.enabled,
          ominousBottleNextDueAt: payload.enabled ? 123456789 : null
        }
        return { allowed: true, settings: ominousSettings }
      }
      if (action === 'periodic_right_click_get') return periodicSettings
      if (action === 'task_get') return payload.name === '单次任务'
        ? { task: { name: '单次任务', steps: [{ type: 'command', command: '切换', args: ['2'] }] } }
        : { task: null }
      if (action === 'schedule_status') return { automation: periodicSettings, tasks: [{ name: '单次任务', intervalTicks: 20 }] }
      if (action === 'periodic_right_click_set') {
        periodicSettings = {
          ...periodicSettings,
          periodicRightClickEnabled: payload.enabled,
          periodicRightClickX: payload.enabled ? payload.x : periodicSettings.periodicRightClickX,
          periodicRightClickY: payload.enabled ? payload.y : periodicSettings.periodicRightClickY,
          periodicRightClickZ: payload.enabled ? payload.z : periodicSettings.periodicRightClickZ,
          periodicRightClickIntervalTicks: payload.enabled ? payload.intervalTicks : periodicSettings.periodicRightClickIntervalTicks
        }
        return { allowed: true, settings: periodicSettings }
      }
      if (action === 'lock_set') {
        lock = payload.locked
          ? { locked: true, adminLocked: payload.level === 'admin', lockedBy: payload.username, reason: payload.reason }
          : { locked: false, adminLocked: false, lockedBy: '', reason: '' }
        return { allowed: true, status: payload.locked ? 'locked' : 'unlocked', lock }
      }
      throw new Error(`unexpected action ${action}`)
    }
  }
  const handler = createSmartCommandHandler(bot, {
    platform,
    commandPrefixes: ['custom-prefix-', bot.username],
    fetchImpl: async url => {
      mapFetches += 1
      mapUrl = url
      return {
        ok: true,
        json: async () => ({
          players: mapPlayers,
          worldSettings: [
            { name: 'world', displayName: '主世界', type: 'overworld' },
            { name: 'world_nether', displayName: '下界', type: 'nether' }
          ]
        })
      }
    },
    scheduleRestart: () => {}
  })

  await handler({ username: 'Guest', message: '@near' })
  assert.deepEqual(chats, [])
  await handler({ username: 'Guest', message: 'PlatformBot版本' })
  assert.equal(chats.pop(), '智能 Bot 版本：v1.0.3')
  await handler({ username: 'Banned', message: 'PlatformBot查白 White' })
  assert.deepEqual(chats, [])
  await handler({ username: 'Guest', message: 'custom-prefix-查白 White' })
  assert.match(chats.pop(), /在白名单中/)
  await handler({ username: 'Guest', message: 'PlatformBot开盒 Target' })
  assert.match(chats.pop(), /\(10,0\) 主世界/)
  await handler({ username: 'Guest', message: 'PlatformBot开盒 NetherClose' })
  assert.match(chats.pop(), /\(10,0\) 地狱/)
  await handler({ username: 'Guest', message: 'PlatformBot开盒 EndPlayer' })
  assert.match(chats.pop(), /\(11,0\) 末地/)
  await handler({ username: 'Guest', message: 'PlatformBotnear' })
  assert.equal(chats.pop(), 'White(3)，Root(4)，Third(6)')
  await handler({ username: 'Guest', message: 'PlatformBotnear Target' })
  assert.equal(chats.pop(), 'White(8)，Guest(11)，Root(12)')
  assert.equal(mapFetches, 1)
  assert.equal(mapUrl, 'https://map.zenoxs.cn/tiles/settings.json')
  await handler({ username: 'White', message: 'PlatformBot上车' })
  assert.match(chats.pop(), /已上车/)
  await handler({ username: 'White', message: 'PlatformBot下车' })
  assert.match(chats.pop(), /已下车/)
  await handler({ username: 'White', message: 'PlatformBot切换 9' })
  assert.equal(quickBarSlot, 8)
  assert.match(chats.pop(), /第 9 格/)
  await handler({ username: 'White', message: 'PlatformBot单次任务' })
  assert.equal(quickBarSlot, 1)
  assert.equal(requests.some(row => row.action === 'task_get' && row.payload.name === '单次任务'), true)
  await handler({ username: 'White', message: 'PlatformBot清空' })
  assert.equal(inventoryItems.length, 0)
  assert.match(chats.pop(), /2 组、37 个/)
  await handler({ username: 'White', message: 'PlatformBot定时灾厄之瓶 开' })
  assert.equal(ominousSettings.ominousBottleEnabled, true)
  assert.match(chats.pop(), /已开启/)
  await handler({ username: 'White', message: 'PlatformBot定时放置 100 64 200 20' })
  assert.equal(periodicSettings.periodicRightClickEnabled, true)
  assert.deepEqual([periodicSettings.periodicRightClickX, periodicSettings.periodicRightClickY, periodicSettings.periodicRightClickZ], [100, 64, 200])
  assert.match(chats.pop(), /定时放置已开启/)
  await handler({ username: 'White', message: 'custom-prefix-指令 /pay Root 1' })
  assert.match(chats.pop(), /高风险/)
  await handler({ username: 'White', message: 'custom-prefix-锁定 safe afk' })
  assert.match(chats.pop(), /锁定成功/)
  await handler({ username: 'White', message: 'custom-prefix-指令 /back' })
  assert.match(chats.pop(), /已被 White 锁定/)
  await handler({ username: 'White', message: 'PlatformBot状态' })
  const status = chats.pop()
  assert.match(status, /定时任务 单次任务/)
  assert.match(status, /已被 White 锁定/)
  await handler({ username: 'Root', message: 'PlatformBot临时加白 NewPlayer 30' })
  assert.match(chats.pop(), /持续 30 分钟/)
  assert.equal(requests.some(row => row.action === 'permission_add' && row.payload.minutes === 30), true)
})

test('smart command tells each player about a newer runtime only once', async () => {
  const bot = { username: 'PlatformBot', chat: message => chats.push(message) }
  const chats = []
  const handler = createSmartCommandHandler(bot, {
    commandPrefixes: ['PlatformBot'],
    platform: {
      request: async action => {
        if (action === 'access') return { blacklisted: false, whitelisted: true, admin: false, lock: { locked: false, adminLocked: false } }
        if (action === 'runtime_version') return { version: '1.0.4' }
        if (action === 'schedule_status') return { automation: {}, tasks: [] }
        throw new Error(`unexpected action ${action}`)
      }
    }
  })

  await handler({ username: 'Alice', message: 'PlatformBot状态' })
  await handler({ username: 'Alice', message: 'PlatformBot状态' })
  assert.equal(chats.filter(message => message.startsWith('/msg Alice ')).length, 1)
  assert.equal(chats.filter(message => message.includes('机器人没有被锁定')).length, 2)
})
