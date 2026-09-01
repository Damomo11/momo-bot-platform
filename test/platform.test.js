const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const PlatformDb = require('../src/db')
const BotManager = require('../src/botManager')
const BotSupervisorClient = require('../src/botSupervisorClient')
const AccountManager = require('../src/accountManager')
const { environmentForValues, normalizeDefinitions, validateValues } = require('../src/templateVariables')
const { EventEmitter } = require('node:events')
const crypto = require('node:crypto')
const http = require('node:http')
const net = require('node:net')
const { execFileSync, spawn } = require('node:child_process')
const { Vec3 } = require('vec3')
const { goals: pathfinderGoals } = require('mineflayer-pathfinder')
const { installZenoxChatParser, normalizeServerChatText } = require('../src/zenoxChatParser')
const { verifyCloudStoreToken } = require('../src/cloudStoreSso')
const { LoginAttemptLimiter, clientIp } = require('../src/security')
const { invalidateMinecraftAccessTokenCache, isMinecraftProfileAuthError } = require('../src/authCache')
const { upgradeObjectState } = require('../src/supervisorHotReload')
const { activateNearestOminousVault, attackAtCursor, bindTaskArguments, createFishingController, createOminousBottleScheduler, createPeriodicRightClickScheduler, createSmartCommandHandler, createTeleportRequestHandler, createVaultAutoOpenController, dismountVehicle, executeCustomTask, installSmartCommands, isVersionNewer, mountNearestMinecart, normalizeItemId, parsePeriodicRightClickArgs, parseSmartCommand, placeAtCursor, placePeriodicRightClick, rightClickTarget } = require('../smart-runtime/commands')

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
  assert.equal(isVersionNewer('1.0.5', '1.0.4'), true)
  assert.equal(isVersionNewer('1.1.0', '1.0.9'), true)
  assert.equal(isVersionNewer('2.0.0', '10.0.0'), false)
  assert.equal(isVersionNewer('1.0.3', '1.0.3'), false)
  assert.equal(isVersionNewer('invalid', '1.0.3'), false)
})

test('supervisor hot reload preserves live state and adds new manager fields', () => {
  class OldManager {
    oldMethod () { return 'old' }
  }
  class NewManager {
    constructor () {
      this.processes = new Map()
      this.newState = new Set(['default'])
    }

    newMethod () { return 'new' }
  }
  const liveProcesses = new Map([['bot-1', { pid: 123 }]])
  const manager = Object.assign(Object.create(OldManager.prototype), { processes: liveProcesses })
  upgradeObjectState(manager, NewManager)
  assert.equal(manager.processes, liveProcesses)
  assert.deepEqual([...manager.processes.keys()], ['bot-1'])
  assert.deepEqual([...manager.newState], ['default'])
  assert.equal(manager.newMethod(), 'new')
})

test('smart top-up settings sync crosses the supervisor boundary and updates running smart bots', async () => {
  const client = Object.create(BotSupervisorClient.prototype)
  let command
  client.command = async (action, payload) => {
    command = { action, payload }
    return true
  }
  await client.syncSmartTopUpSettings()
  assert.deepEqual(command, { action: 'sync_smart_settings', payload: { id: '__all_top_up_settings__' } })

  const settings = { recipient: 'Receiver', commandTemplate: '/pay {recipient} {amount}' }
  const messages = []
  const manager = new BotManager({
    getSmartTopUpSettings: () => settings,
    getBot: id => ({ id, mode: id === 'smart' ? 'smart' : 'signin' })
  }, {})
  manager.pendingTopUps.set('smart', { amount: '1.00' })
  manager.processes.set('smart', { child: { send: message => messages.push(message) } })
  manager.processes.set('signin', { child: { send: message => messages.push(message) } })

  assert.equal(manager.syncSmartSettings('__all_top_up_settings__'), settings)
  assert.equal(manager.pendingTopUps.size, 0)
  assert.deepEqual(messages, [{ type: 'smart_top_up_settings', settings }])
})

test('bot list reports the running runtime version and a newer available version', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-runtime-version-'))
  const instancePath = path.join(root, 'runtime', 'bot-1')
  try {
    fs.mkdirSync(path.join(root, 'smart-runtime'), { recursive: true })
    fs.mkdirSync(instancePath, { recursive: true })
    fs.writeFileSync(path.join(root, 'smart-runtime', 'package.json'), JSON.stringify({ version: '1.2.0' }))
    fs.writeFileSync(path.join(instancePath, 'package.json'), JSON.stringify({ version: '1.1.0' }))
    const manager = new BotManager({
      getModePrices: () => ({ smartHourlyPrice: 0.03, signinOncePrice: 0.01 }),
      getSmartBotScheduleStatus: () => ({ automation: {}, tasks: [] })
    }, { root })
    manager.processes.set('bot-1', { instancePath })
    const row = manager.publicBot({ id: 'bot-1', mode: 'smart', oauthJson: '', templateVarsJson: '' })
    assert.equal(row.runtimeVersion, '1.1.0')
    assert.equal(row.latestRuntimeVersion, '1.2.0')
    assert.equal(row.updateAvailable, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runtime update restart waits for process exit and keeps the bot desired state running', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-runtime-restart-'))
  const instancePath = path.join(root, 'runtime', 'bot-1')
  const bot = { id: 'bot-1', userId: 'user-1', accountId: 'account-1', mode: 'smart', desiredState: 'running', runtimeState: 'online', oauthJson: '', templateVarsJson: '' }
  try {
    fs.mkdirSync(path.join(root, 'smart-runtime'), { recursive: true })
    fs.mkdirSync(instancePath, { recursive: true })
    fs.writeFileSync(path.join(root, 'smart-runtime', 'package.json'), JSON.stringify({ version: '1.2.0' }))
    fs.writeFileSync(path.join(instancePath, 'package.json'), JSON.stringify({ version: '1.1.0' }))
    const db = {
      getBot: () => ({ ...bot }),
      updateBotRuntime: (id, fields) => Object.assign(bot, fields),
      getModePrices: () => ({ smartHourlyPrice: 0.03, signinOncePrice: 0.01 }),
      getSmartBotScheduleStatus: () => ({ automation: {}, tasks: [] })
    }
    const manager = new BotManager(db, { root })
    const signals = []
    const state = {
      child: { kill: signal => signals.push(signal) },
      instancePath,
      runtimeVersion: '1.1.0',
      accountId: bot.accountId,
      protocolIndex: 0,
      billingMode: 'hourly',
      stopping: false
    }
    manager.processes.set(bot.id, state)
    manager.accountLocks.set(bot.accountId, bot.id)
    let launched = null
    manager.launchAttempt = current => { launched = current }

    await manager.restart(bot.id, bot.userId)
    assert.deepEqual(signals, ['SIGTERM'])
    assert.equal(bot.desiredState, 'running')
    assert.equal(bot.runtimeState, 'restarting')
    assert.equal(launched, null)

    manager.handleExit(bot.id, state, 0, 'SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 650))
    assert.equal(launched.id, bot.id)
    assert.equal(bot.desiredState, 'running')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('restart falls back to a fresh start when the process is already gone', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-restart-stopped-'))
  const bot = { id: 'bot-1', userId: 'user-1', accountId: 'account-1', mode: 'smart', desiredState: 'running', runtimeState: 'stopped', accountAuthState: 'authorized', oauthJson: '', templateVarsJson: '', serverHost: 'mc.zenoxs.cn', serverPort: 25565 }
  try {
    fs.mkdirSync(path.join(root, 'smart-runtime'), { recursive: true })
    fs.writeFileSync(path.join(root, 'smart-runtime', 'package.json'), JSON.stringify({ version: '1.2.0' }))
    const db = {
      getBot: () => ({ ...bot }),
      updateBotRuntime: (id, fields) => Object.assign(bot, fields),
      getModePrices: () => ({ smartHourlyPrice: 0.03, signinOncePrice: 0.01 }),
      getSmartBotScheduleStatus: () => ({ automation: {}, tasks: [] }),
      getUser: () => ({ availableMomoc: 100 }),
      getRuntimeSettings: () => ({ maxRunningBots: 0 })
    }
    const manager = new BotManager(db, { root })
    let launched = null
    manager.launchAttempt = current => { launched = current }

    await manager.restart(bot.id, bot.userId)
    assert.equal(bot.desiredState, 'running')
    assert.equal(bot.runtimeState, 'starting')
    assert.equal(launched.id, bot.id)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Zenox connections always use only Minecraft 1.21.11', () => {
  const manager = new BotManager({}, {})
  assert.deepEqual(manager.protocolVersions({ serverHost: 'mc.zenoxs.cn', minecraftVersion: '1.21.8' }), ['1.21.11'])
  assert.deepEqual(manager.protocolVersions({ serverHost: 'MC.ZENOXS.CN', minecraftVersion: '' }), ['1.21.11'])
  assert.deepEqual(manager.protocolVersions({ serverHost: 'example.org', minecraftVersion: '1.20.4' }), ['1.20.4'])
})

test('connection timeout retries the same version without stopping the bot', async () => {
  const bot = {
    id: 'bot-timeout',
    userId: 'user-1',
    accountId: 'account-1',
    mode: 'smart',
    desiredState: 'running',
    runtimeState: 'connecting',
    lastError: '',
    oauthJson: '',
    templateVarsJson: '',
    serverHost: 'mc.zenoxs.cn',
    minecraftVersion: '1.21.11'
  }
  const db = {
    getBot: () => ({ ...bot }),
    updateBotRuntime: (id, fields) => Object.assign(bot, fields),
    getModePrices: () => ({ smartHourlyPrice: 0.03, signinOncePrice: 0.01 }),
    getSmartBotScheduleStatus: () => ({ automation: {}, tasks: [] })
  }
  const manager = new BotManager(db, { reconnectDelayMs: 10 })
  const signals = []
  const state = {
    child: { kill: signal => signals.push(signal) },
    accountId: bot.accountId,
    versions: ['1.21.11'],
    protocolIndex: 0,
    activeVersion: '1.21.11',
    billingMode: 'hourly',
    priceMomoc: 0.03,
    stopping: false,
    retryPending: false,
    profileAuthRecoveryPending: false,
    reachedOnline: false
  }
  manager.processes.set(bot.id, state)
  manager.accountLocks.set(bot.accountId, bot.id)
  let launched = null
  manager.launchAttempt = (current, protocolIndex) => { launched = { current, protocolIndex } }

  assert.equal(manager.requestConnectionRetry(bot.id, '120 秒内仍未进入服务器'), true)
  assert.equal(bot.desiredState, 'running')
  assert.equal(bot.runtimeState, 'reconnecting')
  assert.match(bot.lastError, /安排安全重连/)
  assert.deepEqual(signals, ['SIGTERM'])

  manager.handleExit(bot.id, state, 0, 'SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(launched.current.id, bot.id)
  assert.equal(launched.protocolIndex, 0)
  assert.equal(bot.desiredState, 'running')
})

test('a stopped Minecraft connection terminates its runtime and automatically reconnects', async () => {
  const bot = {
    id: 'bot-1',
    userId: 'user-1',
    accountId: 'account-1',
    mode: 'smart',
    desiredState: 'running',
    runtimeState: 'online',
    lastError: 'Kicked: connection problem',
    oauthJson: '',
    templateVarsJson: ''
  }
  const db = {
    getBot: () => ({ ...bot }),
    updateBotRuntime: (id, fields) => Object.assign(bot, fields),
    getModePrices: () => ({ smartHourlyPrice: 0.03, signinOncePrice: 0.01 }),
    getSmartBotScheduleStatus: () => ({ automation: {}, tasks: [] })
  }
  const manager = new BotManager(db, { reconnectDelayMs: 10 })
  const signals = []
  const state = {
    child: { kill: signal => signals.push(signal) },
    accountId: bot.accountId,
    protocolIndex: 0,
    billingMode: 'hourly',
    stopping: false,
    reachedOnline: true
  }
  manager.processes.set(bot.id, state)
  manager.accountLocks.set(bot.accountId, bot.id)
  let launched = null
  manager.launchAttempt = current => { launched = current }

  manager.handleMessage(bot.id, { type: 'state', state: 'stopped', reason: 'socketClosed' })
  assert.equal(state.disconnectPending, true)
  assert.deepEqual(signals, ['SIGTERM'])
  manager.handleExit(bot.id, state, 0, 'SIGTERM')
  assert.equal(bot.runtimeState, 'reconnecting')
  assert.match(bot.lastError, /连续失败 1 次，1 秒后重试/)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(launched.id, bot.id)
})

test('reconnect protection backs off accounts and opens one server probe after distinct failures', () => {
  let now = 1_000_000
  const bots = new Map([
    ['bot-1', { id: 'bot-1', accountId: 'account-1', serverHost: 'mc.example.test', serverPort: 25565, desiredState: 'running' }],
    ['bot-2', { id: 'bot-2', accountId: 'account-2', serverHost: 'MC.EXAMPLE.TEST', serverPort: 25565, desiredState: 'running' }],
    ['bot-3', { id: 'bot-3', accountId: 'account-3', serverHost: 'mc.example.test', serverPort: 25565, desiredState: 'running' }],
    ['bot-4', { id: 'bot-4', accountId: 'account-4', serverHost: 'other.example.test', serverPort: 25565, desiredState: 'running' }]
  ])
  const updates = new Map()
  const manager = new BotManager({
    getBot: id => bots.get(id),
    updateBotRuntime: (id, fields) => updates.set(id, fields)
  }, {
    now: () => now,
    reconnectDelaysMs: [60_000, 120_000, 300_000],
    reconnectJitterRatio: 0,
    serverFailureWindowMs: 60_000,
    serverCircuitThreshold: 3,
    serverCircuitDelaysMs: [120_000, 300_000],
    serverProbeStableMs: 120_000
  })

  assert.equal(manager.recordAccountReconnectFailure(bots.get('bot-1')).delayMs, 60_000)
  assert.equal(manager.recordAccountReconnectFailure(bots.get('bot-1')).delayMs, 120_000)
  assert.equal(manager.recordAccountReconnectFailure(bots.get('bot-1')).delayMs, 300_000)

  assert.equal(manager.recordServerConnectionFailure(bots.get('bot-1'), 'bot-1'), null)
  assert.equal(manager.recordServerConnectionFailure(bots.get('bot-1'), 'bot-1'), null)
  assert.equal(manager.recordServerConnectionFailure(bots.get('bot-2'), 'bot-2'), null)
  const circuit = manager.recordServerConnectionFailure(bots.get('bot-3'), 'bot-3')
  assert.equal(circuit.nextProbeAt, now + 120_000)
  assert.equal(manager.serverCircuits.size, 1)

  now = circuit.nextProbeAt
  const launched = []
  manager.launchAttempt = bot => launched.push(bot.id)
  manager.runScheduledReconnect('bot-2', { protocolIndex: 0, billingMode: 'hourly', priceMomoc: 0.03 })
  manager.runScheduledReconnect('bot-3', { protocolIndex: 0, billingMode: 'hourly', priceMomoc: 0.03 })
  assert.deepEqual(launched, ['bot-2'])
  assert.equal(circuit.probeBotId, 'bot-2')
  assert.equal(updates.get('bot-3').runtimeState, 'circuit_open')
  manager.cancelReconnect('bot-3')

  manager.recordServerConnectionFailure(bots.get('bot-2'), 'bot-2')
  assert.equal(circuit.probeBotId, null)
  assert.equal(circuit.nextProbeAt, now + 300_000)
  assert.equal(manager.recordServerConnectionFailure(bots.get('bot-4'), 'bot-4'), null)
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

function fixture ({ newUserInitialMomoc = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-'))
  const config = {
    databasePath: path.join(root, 'data.sqlite'),
    sessionDays: 30,
    bootstrapAdminUsername: 'admin',
    bootstrapAdminPassword: 'admin-password-123'
  }
  const db = new PlatformDb(config)
  if (newUserInitialMomoc !== null) db.setNewUserInitialMomoc(newUserInitialMomoc)
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

test('new local and cloud store users receive the configurable initial momoc once', () => {
  const f = fixture({ newUserInitialMomoc: null })
  try {
    assert.equal(f.db.getNewUserInitialMomoc(), 10)

    const local = f.db.createUser('initial_local', 'password-123')
    assert.equal(local.momoc, 10)
    assert.deepEqual(f.db.listLedger(local.id).map(row => ({ kind: row.kind, delta: row.delta, balanceAfter: row.balanceAfter })), [
      { kind: 'signup_bonus', delta: 10, balanceAfter: 10 }
    ])

    const cloud = f.db.upsertCloudStoreUser('uuid-initial', 'CloudPlayer', 'Damomo1')
    assert.equal(cloud.momoc, 10)
    assert.equal(f.db.upsertCloudStoreUser('uuid-initial', 'CloudRenamed', 'Damomo1').momoc, 10)
    assert.equal(f.db.listLedger(cloud.id).filter(row => row.kind === 'signup_bonus').length, 1)

    assert.equal(f.db.setNewUserInitialMomoc(2.5), 2.5)
    assert.equal(f.db.createUser('configured_user', 'password-123').momoc, 2.5)
    assert.throws(() => f.db.setNewUserInitialMomoc(-1), /不能小于 0/)
    assert.throws(() => f.db.setNewUserInitialMomoc(0.0000001), /最多支持 6 位小数/)

    f.db.setNewUserInitialMomoc(0)
    const zero = f.db.createUser('zero_initial', 'password-123')
    assert.equal(zero.momoc, 0)
    assert.equal(f.db.listLedger(zero.id).length, 0)
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

test('Microsoft authorization deduplicates active requests and rate limits immediate retries', async () => {
  const account = { id: 'account-1', userId: 'user-1', authState: 'pending' }
  const db = {
    getMicrosoftAccount: () => ({ ...account }),
    updateMicrosoftAccountAuth: (id, fields) => Object.assign(account, fields)
  }
  const manager = new AccountManager(db, { authCacheRoot: '.', accountAuthorizationCooldownMs: 30000 })
  let runs = 0
  let finish
  manager.runAuthorization = async () => {
    runs += 1
    await new Promise(resolve => { finish = resolve })
  }

  manager.authorize(account.id, account.userId)
  manager.authorize(account.id, account.userId)
  assert.equal(runs, 1)
  finish()
  await manager.authorizing.get(account.id).promise
  assert.throws(() => manager.authorize(account.id, account.userId), error => error.status === 429 && /请求过于频繁/.test(error.message))
})

test('pending Microsoft authorization can be deleted and cancels the active request', async () => {
  let account = { id: 'account-1', userId: 'user-1', authState: 'pending' }
  let manager
  const db = {
    getMicrosoftAccount: () => account ? { ...account } : null,
    updateMicrosoftAccountAuth: (id, fields) => Object.assign(account, fields),
    deleteMicrosoftAccount: id => {
      assert.equal(id, account.id)
      assert.equal(manager.authorizing.get(id).cancelled, true)
      account = null
      return 1
    }
  }
  manager = new AccountManager(db, { authCacheRoot: '.', accountAuthorizationCooldownMs: 30000 })
  let finish
  manager.runAuthorization = async () => {
    await new Promise(resolve => { finish = resolve })
  }

  manager.authorize('account-1', account.userId)
  assert.equal(manager.authorizing.get('account-1').cancelled, false)
  assert.equal(manager.remove('account-1', account.userId), true)
  assert.equal(manager.authorizationStartedAt.has('account-1'), false)
  finish()
  await manager.authorizing.get('account-1').promise
  assert.equal(manager.authorizing.has('account-1'), false)
})

test('OAuth code refresh cancels the active authorization and is rate limited for one minute', async () => {
  const account = { id: 'account-1', userId: 'user-1', authState: 'auth_required', oauth: { userCode: 'OLD' } }
  const db = {
    getMicrosoftAccount: () => ({ ...account }),
    updateMicrosoftAccountAuth: (id, fields) => Object.assign(account, fields)
  }
  const manager = new AccountManager(db, { authCacheRoot: '.', accountOAuthRefreshCooldownMs: 60000 })
  const runs = []
  const finishes = []
  manager.runAuthorization = async (current, force, authorization) => {
    runs.push({ force, authorization })
    await new Promise(resolve => finishes.push(resolve))
  }

  manager.authorize(account.id, account.userId)
  manager.authorize(account.id, account.userId, false, { refreshCode: true })
  assert.equal(runs.length, 2)
  assert.equal(runs[0].authorization.cancelled, true)
  assert.equal(runs[1].force, true)
  assert.throws(
    () => manager.authorize(account.id, account.userId, false, { refreshCode: true }),
    error => error.status === 429 && /60 秒后重试/.test(error.message)
  )

  finishes.forEach(resolve => resolve())
  await Promise.all(runs.map(run => run.authorization.promise))
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

test('smart momoc exemption follows the licensed Minecraft name across bot recreation', async () => {
  const f = fixture()
  try {
    const user = f.db.createUser('exempt_owner', 'password-123')
    const account = f.db.createMicrosoftAccount(user.id, 'exempt@example.com')
    f.db.updateMicrosoftAccountAuth(account.id, { authState: 'authorized', minecraftName: 'LicensedBot' })
    const first = f.db.createBot(user.id, { accountId: account.id, mode: 'smart', label: 'First', serverHost: 'localhost' })

    assert.deepEqual(f.db.setSmartBotMomocExemption(first.id, true, 'admin'), { minecraftName: 'LicensedBot', enabled: true })
    assert.equal(f.db.chargeHourlyMinute(first.id, 0.03).exempt, true)
    assert.equal(f.db.getUser(user.id).momoc, 0)
    assert.equal(f.db.getBot(first.id).billedMinutes, 0)
    assert.equal(f.db.listLedger(user.id).some(row => row.kind === 'bot_hourly'), false)

    f.db.deleteBot(first.id)
    const recreated = f.db.createBot(user.id, { accountId: account.id, mode: 'smart', label: 'Recreated', serverHost: 'localhost' })
    assert.deepEqual(f.db.getSmartBotMomocExemption(recreated.id), { minecraftName: 'LicensedBot', enabled: true })
    const manager = new BotManager(f.db, {})
    manager.launchAttempt = () => {}
    await assert.doesNotReject(manager.start(recreated.id))
    assert.equal(manager.publicBot(f.db.getBot(recreated.id)).momocExempt, true)

    assert.deepEqual(f.db.setSmartBotMomocExemption(recreated.id, false, 'admin'), { minecraftName: 'LicensedBot', enabled: false })
    assert.equal(f.db.chargeHourlyMinute(recreated.id, 0.03).ok, false)
  } finally { f.close() }
})

test('smart daily settings persist and claim each action at most once per date', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('daily_settings_owner', 'password-123')
    const bot = f.db.createBot(user.id, { mode: 'smart', label: 'Daily', microsoftEmail: 'daily@example.com', serverHost: 'localhost' })
    assert.equal(f.db.getSmartBotSettings(bot.id).autoRenewEnabled, false)
    assert.equal(f.db.setSmartBotSettings(bot.id, { commandPrefix: 'daily!', autoRenewEnabled: true }).autoRenewEnabled, true)
    assert.equal(f.db.claimSmartBotDailyAction(bot.id, 'signin', '2026-08-23'), true)
    assert.equal(f.db.claimSmartBotDailyAction(bot.id, 'signin', '2026-08-23'), false)
    assert.equal(f.db.claimSmartBotDailyAction(bot.id, 'auto_renew', '2026-08-23'), true)
    assert.equal(f.db.claimSmartBotDailyAction(bot.id, 'auto_renew', '2026-08-23'), false)
    assert.equal(f.db.claimSmartBotDailyAction(bot.id, 'signin', '2026-08-24'), true)
    f.db.setSmartBotSettings(bot.id, { autoRenewEnabled: false })
    assert.equal(f.db.claimSmartBotDailyAction(bot.id, 'auto_renew', '2026-08-24'), false)
  } finally { f.close() }
})

test('server chat signs in online smart bots once from 00:00 through 00:05 Beijing time', async () => {
  const f = fixture()
  try {
    const user = f.db.createUser('daily_scheduler_owner', 'password-123')
    const first = f.db.createBot(user.id, { mode: 'smart', label: 'Online', microsoftEmail: 'daily-online@example.com', serverHost: 'localhost' })
    const offline = f.db.createBot(user.id, { mode: 'smart', label: 'Offline', microsoftEmail: 'daily-offline@example.com', serverHost: 'localhost' })
    const signin = f.db.createBot(user.id, { mode: 'signin', label: 'Signin', microsoftEmail: 'daily-signin@example.com', serverHost: 'localhost' })
    let now = Date.parse('2026-08-22T16:00:00Z')
    const manager = new BotManager(f.db, { now: () => now, timeSyncEnabled: false })
    const firstMessages = []
    const offlineMessages = []
    const signinMessages = []
    manager.processes.set(first.id, { reachedOnline: true, child: { send: message => firstMessages.push(message) } })
    manager.processes.set(offline.id, { reachedOnline: false, child: { send: message => offlineMessages.push(message) } })
    manager.processes.set(signin.id, { reachedOnline: true, child: { send: message => signinMessages.push(message) } })

    manager.handleMessage(first.id, { type: 'server_message', message: '玩家聊天' })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(firstMessages, [
      { type: 'smart_daily_action', action: 'signin', command: '/signin click' }
    ])
    assert.deepEqual(offlineMessages, [])
    assert.deepEqual(signinMessages, [])

    now = Date.parse('2026-08-22T16:03:00Z')
    await manager.runDailySignin(now)
    now = Date.parse('2026-08-22T16:05:00Z')
    await manager.runDailySignin(now)
    assert.equal(firstMessages.length, 1)

    const late = f.db.createBot(user.id, { mode: 'smart', label: 'Late', microsoftEmail: 'daily-late@example.com', serverHost: 'localhost' })
    const lateMessages = []
    manager.processes.set(late.id, { reachedOnline: true, child: { send: message => lateMessages.push(message) } })
    now = Date.parse('2026-08-22T16:06:00Z')
    await manager.runDailySignin(now)
    assert.deepEqual(lateMessages, [])
  } finally { f.close() }
})

test('daily scheduler renews online smart bots after 00:02', async () => {
  const f = fixture()
  try {
    const user = f.db.createUser('daily_renew_owner', 'password-123')
    const bot = f.db.createBot(user.id, { mode: 'smart', label: 'Online', microsoftEmail: 'daily-renew@example.com', serverHost: 'localhost' })
    f.db.setSmartBotSettings(bot.id, { autoRenewEnabled: true })
    const now = Date.parse('2026-08-22T16:02:00Z')
    const manager = new BotManager(f.db, { now: () => now, timeSyncEnabled: false })
    const messages = []
    manager.processes.set(bot.id, { reachedOnline: true, child: { send: message => messages.push(message) } })

    await manager.runDailyAutomations()
    assert.deepEqual(messages, [
      { type: 'smart_daily_action', action: 'auto_renew', command: '/pay Damomo1 1.00' }
    ])
    assert.equal(manager.pendingTopUps.get(bot.id).silent, true)
  } finally { f.close() }
})

test('smart auto-renew command is restricted to admins and persists the switch', async () => {
  const chats = []
  const requests = []
  let admin = false
  const handler = createSmartCommandHandler({ username: 'PlatformBot', chat: message => chats.push(message) }, {
    commandPrefixes: ['PlatformBot'],
    platform: {
      request: async (action, payload) => {
        requests.push({ action, payload })
        if (action === 'access') return { blacklisted: false, whitelisted: true, admin, lock: { locked: false, adminLocked: false } }
        if (action === 'runtime_version') return { version: '1.0.0' }
        if (action === 'auto_renew_set') return { allowed: true, settings: { autoRenewEnabled: payload.enabled } }
        throw new Error(`unexpected action ${action}`)
      }
    }
  })

  await handler({ username: 'White', message: 'PlatformBot自动续费 开' })
  assert.equal(requests.some(row => row.action === 'auto_renew_set'), false)
  admin = true
  await handler({ username: 'RootPlayer', message: 'PlatformBot自动续费 开' })
  assert.deepEqual(requests.find(row => row.action === 'auto_renew_set').payload, { username: 'RootPlayer', enabled: true })
  assert.equal(chats.at(-1), '自动续费已开启。')
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

test('bot runtime log fallback retains 100 general and 500 related entries', () => {
  const manager = new BotManager({ getModePrices: () => ({ smartHourlyPrice: 0.03, signinOncePrice: 0.01 }) }, {})
  for (let index = 0; index < 102; index++) manager.appendLog('bot-log-test', 'info', `line ${index}`)
  const logs = manager.listLogs('bot-log-test')
  assert.equal(logs.length, 100)
  assert.equal(logs[0].message, 'line 2')
  assert.equal(logs.at(-1).message, 'line 101')
  logs[0].message = 'changed by caller'
  assert.equal(manager.listLogs('bot-log-test')[0].message, 'line 2')
  for (let index = 0; index < 502; index++) manager.appendRelatedLog('bot-log-test', 'audit', `related ${index}`)
  assert.equal(manager.listRelatedLogs('bot-log-test').length, 500)
  assert.equal(manager.listRelatedLogs('bot-log-test')[0].message, 'related 2')
  manager.appendLog('bot-log-secret', 'stdout', '{"access_token":"secret-token", "user_code":"device-code"} Authorization: bearer-token')
  const redacted = manager.listLogs('bot-log-secret')[0].message
  assert.doesNotMatch(redacted, /secret-token|device-code|bearer-token/)
  assert.match(redacted, /\[redacted\]/)
  manager.appendLog('bot-log-test', 'stdout', '[message:public] Player: unrelated server chat')
  assert.equal(manager.listLogs('bot-log-test').some(entry => entry.message.includes('unrelated server chat')), false)
  const bot = manager.publicBot({ id: 'bot-log-test', mode: 'smart', oauthJson: '', templateVarsJson: '' })
  assert.deepEqual(bot.logs, [])
})

test('bot logs persist across database reopen and enforce category limits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-logs-'))
  const config = { databasePath: path.join(root, 'data.sqlite') }
  let db = new PlatformDb(config)
  try {
    const user = db.createUser('log_owner', 'password-123')
    const bot = db.createBot(user.id, { mode: 'smart', label: 'Log Bot', microsoftEmail: 'logs@example.com', serverHost: 'localhost' })
    const manager = new BotManager(db, {})
    for (let index = 0; index < 105; index++) manager.appendLog(bot.id, 'info', `general ${index}`)
    for (let index = 0; index < 505; index++) manager.appendRelatedLog(bot.id, 'audit', `related ${index}`)
    db.close()

    db = new PlatformDb(config)
    assert.equal(db.listBotLogs(bot.id, 'general').length, 100)
    assert.equal(db.listBotLogs(bot.id, 'general')[0].message, 'general 5')
    assert.equal(db.listBotLogs(bot.id, 'related').length, 500)
    assert.equal(db.listBotLogs(bot.id, 'related')[0].message, 'related 5')
  } finally {
    if (db.db.open) db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
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

test('mount always interacts with the nearest minecart even when already mounted', async () => {
  const entity = { position: { distanceTo: () => 2 } }
  const minecart = { id: 7, name: 'minecart', position: {}, passengers: [entity] }
  const mounted = []
  const bot = {
    entity,
    entities: { 7: minecart },
    vehicle: minecart,
    nearestEntity: predicate => predicate(minecart) ? minecart : null,
    mount: target => mounted.push(target)
  }
  assert.deepEqual(await mountNearestMinecart(bot), { status: 'mounted' })
  assert.deepEqual(mounted, [minecart])
})

test('vehicle state left behind by death is cleared before mount and dismount', async () => {
  const oldPlayerEntity = { id: 1 }
  const respawnedEntity = { id: 2, position: { distanceTo: () => 2 } }
  const minecart = { id: 7, name: 'minecart', position: {}, passengers: [oldPlayerEntity] }
  const bot = {
    entity: respawnedEntity,
    entities: { 7: minecart },
    vehicle: minecart,
    nearestEntity: predicate => predicate(minecart) ? minecart : null,
    mount: target => {
      target.passengers.push(respawnedEntity)
      respawnedEntity.vehicle = target
      bot.vehicle = target
    }
  }

  assert.deepEqual(await dismountVehicle(bot), { status: 'missing' })
  assert.equal(bot.vehicle, null)
  assert.deepEqual(await mountNearestMinecart(bot), { status: 'mounted' })
  assert.equal(bot.vehicle, minecart)
})

test('open vault finds only ominous vaults and activates them through blocks via protocol', async () => {
  const written = []
  const swings = []
  const equipped = []
  const plainVault = { name: 'vault', displayName: 'Vault' }
  const ominousVault = { name: 'vault', displayName: 'Vault', getProperties: () => ({ ominous: true, vault_state: 'inactive' }), position: new Vec3(5, 64, 5) }
  const trialKey = { name: 'ominous_trial_key', count: 1, slot: 3 }
  const bot = {
    entity: {},
    findBlock: options => [plainVault, ominousVault].find(options.matching) || null,
    heldItem: null,
    inventory: { items: () => [trialKey] },
    equip: async (item, destination) => equipped.push({ item, destination }),
    supportFeature: feature => feature === 'blockPlaceHasHandAndFloatCursor',
    _client: { write: (name, data) => written.push({ name, data }) },
    swingArm: hand => swings.push(hand)
  }
  const result = await activateNearestOminousVault(bot)
  assert.equal(result.status, 'activated')
  assert.equal(result.block, ominousVault)
  assert.deepEqual(equipped, [{ item: trialKey, destination: 'hand' }])
  assert.deepEqual(written, [{ name: 'block_place', data: { location: ominousVault.position, direction: 1, hand: 0, cursorX: 0.5, cursorY: 1, cursorZ: 0.5 } }])
  assert.deepEqual(swings, ['right'])

  const noKeyBot = {
    entity: {},
    findBlock: options => options.matching(ominousVault) ? ominousVault : null,
    heldItem: null,
    inventory: { items: () => [] },
    supportFeature: () => true,
    _client: { write: () => {} },
    swingArm: () => {}
  }
  assert.equal((await activateNearestOminousVault(noKeyBot)).status, 'missing_key')
})

test('vault auto-open controller waits for the teleport to land, then keeps scanning until the ominous vault loads', async () => {
  const written = []
  const ominousVault = { name: 'vault', displayName: 'Vault', getProperties: () => ({ ominous: true, vault_state: 'inactive' }), position: new Vec3(2, 64, 2) }
  let findCalls = 0
  const position = {
    x: 0, y: 64, z: 0,
    distanceTo (other) { return Math.abs(this.x - other.x) + Math.abs(this.y - other.y) + Math.abs(this.z - other.z) },
    clone () { return { x: this.x, y: this.y, z: this.z, distanceTo: this.distanceTo.bind(this) } }
  }
  const bot = {
    entity: { position },
    heldItem: { name: 'ominous_trial_key' },
    findBlock: options => { findCalls += 1; return findCalls >= 4 && options.matching(ominousVault) ? ominousVault : null },
    supportFeature: feature => feature === 'blockPlaceHasHandAndFloatCursor',
    _client: { write: (name, data) => written.push({ name, data }) },
    swingArm: () => {}
  }
  const timers = []
  let now = 0
  const controller = createVaultAutoOpenController(bot, {
    runBotAction: task => task(),
    setTimer: (fn, ms) => { const timer = { fn, at: now + ms, cleared: false }; timers.push(timer); return timer },
    clearTimer: timer => { timer.cleared = true },
    vaultScanIntervalMs: 500
  })

  const tick = async ms => {
    now += ms
    for (const timer of timers) {
      if (!timer.cleared && !timer.done && timer.at <= now) { timer.done = true; timer.fn() }
    }
    await new Promise(resolve => setImmediate(resolve))
  }

  controller.applySettings({ vaultAutoOpenEnabled: true })
  controller.scheduleOpen(position.clone())
  await tick(0)
  await tick(250)
  await tick(250)
  assert.equal(findCalls, 0, 'teleport not landed yet, no scanning')

  position.x = 50
  await tick(250)
  assert.equal(findCalls, 1, 'first scan right after landing')
  assert.deepEqual(written, [])
  await tick(500)
  assert.equal(findCalls, 2)
  await tick(500)
  await tick(500)
  assert.equal(findCalls, 4)
  assert.deepEqual(written, [{ name: 'block_place', data: { location: ominousVault.position, direction: 1, hand: 0, cursorX: 0.5, cursorY: 1, cursorZ: 0.5 } }])

  const scansAfterFound = findCalls
  await tick(2000)
  assert.equal(findCalls, scansAfterFound)
  controller.stop()
})

test('vault auto-open controller keeps scanning when a scan attempt throws', async () => {
  const written = []
  const ominousVault = { name: 'vault', displayName: 'Vault', getProperties: () => ({ ominous: true }), position: new Vec3(2, 64, 2) }
  let findCalls = 0
  const position = {
    x: 0, y: 64, z: 0,
    distanceTo () { return 10 },
    clone () { return { distanceTo: this.distanceTo.bind(this) } }
  }
  const bot = {
    entity: { position },
    heldItem: { name: 'ominous_trial_key' },
    findBlock: options => { findCalls += 1; if (findCalls === 1) throw new Error('Chunk not loaded'); return options.matching(ominousVault) ? ominousVault : null },
    supportFeature: feature => feature === 'blockPlaceHasHandAndFloatCursor',
    _client: { write: (name, data) => written.push({ name, data }) },
    swingArm: () => {}
  }
  const timers = []
  let now = 0
  const controller = createVaultAutoOpenController(bot, {
    runBotAction: task => task(),
    setTimer: (fn, ms) => { const timer = { fn, at: now + ms, cleared: false }; timers.push(timer); return timer },
    clearTimer: timer => { timer.cleared = true },
    vaultScanIntervalMs: 500
  })
  const tick = async ms => {
    now += ms
    for (const timer of timers) {
      if (!timer.cleared && !timer.done && timer.at <= now) { timer.done = true; timer.fn() }
    }
    await new Promise(resolve => setImmediate(resolve))
  }

  controller.applySettings({ vaultAutoOpenEnabled: true })
  controller.scheduleOpen(position.clone())
  await tick(250)
  assert.equal(findCalls, 1)
  assert.deepEqual(written, [])
  await tick(500)
  assert.equal(findCalls, 2, 'scan resumed after the failed attempt')
  assert.deepEqual(written, [{ name: 'block_place', data: { location: ominousVault.position, direction: 1, hand: 0, cursorX: 0.5, cursorY: 1, cursorZ: 0.5 } }])
  controller.stop()
})

test('teleport handler triggers onTeleported only for tpahere requests with the pre-teleport position', async () => {
  const chats = []
  const position = {
    x: 5, y: 64, z: 5,
    distanceTo (other) { return Math.abs(this.x - other.x) },
    clone () { return { x: this.x, y: this.y, z: this.z } }
  }
  const bot = { username: 'PlatformBot', entity: { position }, chat: message => chats.push(message) }
  const teleported = []
  const handler = createTeleportRequestHandler(bot, {
    platform: { request: async action => action === 'access' ? { blacklisted: false, whitelisted: true, admin: false, lock: { locked: false, adminLocked: false } } : null },
    onTeleported: (name, beforePosition) => teleported.push([name, beforePosition])
  })

  await handler({ username: 'White', kind: 'to_bot' })
  await handler({ username: 'White', kind: 'to_requester' })
  assert.deepEqual(chats, ['/tpaccept White', '/tpaccept White'])
  assert.deepEqual(teleported, [['White', { x: 5, y: 64, z: 5 }]])
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

test('smart runtime reports command callers and tpahere senders to related logs', async () => {
  const bot = new EventEmitter()
  bot.username = 'PlatformBot'
  bot.chat = () => {}
  const related = []
  const automation = {
    ominousBottleEnabled: false,
    fishingEnabled: false,
    fishingIntervalTicks: 10,
    periodicRightClickEnabled: false,
    periodicRightClickIntervalTicks: 20
  }
  const platform = {
    relatedLog: message => related.push(message),
    request: async (action, payload) => {
      if (action === 'settings') return { commandPrefix: '', messageOverrides: {}, topUp: {} }
      if (action === 'volatile_schedules_reset') return { automation, tasks: [] }
      if (['ominous_schedule_get', 'fishing_schedule_get', 'periodic_right_click_get'].includes(action)) return automation
      if (action === 'task_list') return { tasks: [] }
      if (action === 'access') return { blacklisted: false, whitelisted: false, admin: false, lock: { locked: false, adminLocked: false } }
      throw new Error(`unexpected action ${action}: ${JSON.stringify(payload)}`)
    }
  }
  const remove = installSmartCommands(bot, { platform, commandPrefixes: ['PlatformBot'] })
  try {
    bot.emit('botPlatformMessage', { username: 'GuestOne', message: 'PlatformBot移动 北 5', channel: 'public' })
    bot.emit('botPlatformTeleportRequest', { username: 'HereOne', kind: 'to_requester' })
    bot.emit('botPlatformTeleportRequest', { username: 'TpaOne', kind: 'to_bot' })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(related.some(message => message.includes('玩家 GuestOne 调用 Bot 指令：移动 北 5')), true)
    assert.equal(related.some(message => message.includes('玩家 HereOne 向 Bot 发送了 /tpahere')), true)
    assert.equal(related.some(message => message.includes('TpaOne') && message.includes('/tpahere')), false)
  } finally { remove() }
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

test('player right click sends the interact-at packet used by the head-sit feature', async () => {
  const target = { id: 17, type: 'player', username: 'WhiteOne', height: 1.8, position: { offset: (x, y, z) => ({ x, y, z }) } }
  const calls = []
  const bot = {
    entities: { 1: target },
    entity: { position: { distanceTo: () => 3 } },
    heldItem: { name: 'shulker_box' },
    setQuickBarSlot: () => { throw new Error('player interaction must not switch the held item') },
    lookAt: async (point, force) => calls.push({ type: 'look', point, force }),
    _client: { write: (name, packet) => calls.push({ type: 'packet', name, packet }) }
  }
  await rightClickTarget(bot, ['whiteone'])
  assert.deepEqual(calls, [
    { type: 'look', point: { x: 0, y: 1.1700000000000002, z: 0 }, force: true },
    {
      type: 'packet',
      name: 'use_entity',
      packet: { target: 17, mouse: 2, x: 0, y: 1.1700000000000002, z: 0, sneaking: false, hand: 0 }
    }
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

test('automatic fishing state persists across database and Bot restarts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-fishing-'))
  const config = { databasePath: path.join(root, 'data.sqlite'), sessionDays: 30 }
  let db = new PlatformDb(config)
  try {
    const user = db.createUser('fishing_owner', 'password-123')
    const bot = db.createBot(user.id, { mode: 'smart', label: 'Fisher', microsoftEmail: 'fisher@example.com', serverHost: 'localhost' })
    const enabled = db.setSmartBotFishing(bot.id, true, 20)
    assert.equal(enabled.fishingEnabled, true)
    assert.equal(enabled.fishingIntervalTicks, 20)
    assert.throws(() => db.setSmartBotFishing(bot.id, true, 0), /1-1728000gt/)

    db.close()
    db = new PlatformDb(config)
    assert.equal(db.getSmartBotAutomation(bot.id).fishingEnabled, true)
    assert.equal(db.getSmartBotAutomation(bot.id).fishingIntervalTicks, 20)
    const restarted = db.resetSmartBotVolatileSchedules(bot.id).automation
    assert.equal(restarted.fishingEnabled, true)
    assert.equal(restarted.fishingIntervalTicks, 20)
    assert.equal(db.setSmartBotFishing(bot.id, false).fishingEnabled, false)
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('in-game restart preparation bypasses reconnect backoff and relaunches promptly', async () => {
  const bot = { id: 'bot-ingame-restart', userId: 'user-1', accountId: 'account-1', mode: 'smart', desiredState: 'running', runtimeState: 'online', lastError: 'old error', oauthJson: '' }
  const db = {
    getBot: () => ({ ...bot }),
    getSmartAccess: (userId, username) => ({ admin: username === 'RootPlayer', blacklisted: false, playerName: username }),
    getSmartBotLock: () => ({ locked: false, adminLocked: false }),
    updateBotRuntime: (id, fields) => Object.assign(bot, fields)
  }
  const manager = new BotManager(db, {})
  const state = { child: {}, accountId: bot.accountId, protocolIndex: 0, billingMode: 'hourly', stopping: false }
  manager.processes.set(bot.id, state)
  manager.accountLocks.set(bot.accountId, bot.id)
  let launched = null
  manager.launchAttempt = current => { launched = current }

  assert.deepEqual(manager.executeSmartRequest(bot.id, 'runtime_restart_prepare', { username: 'Guest' }), { allowed: false, silent: true })
  assert.equal(state.restartPending, undefined)
  assert.deepEqual(manager.executeSmartRequest(bot.id, 'runtime_restart_prepare', { username: 'RootPlayer' }), { allowed: true })
  assert.equal(state.restartPending, true)
  assert.equal(bot.runtimeState, 'restarting')
  assert.equal(bot.lastError, '')

  manager.handleExit(bot.id, state, 0, null)
  await new Promise(resolve => setTimeout(resolve, 650))
  assert.equal(launched.id, bot.id)
  assert.equal(manager.accountReconnects.has(bot.accountId), false)
  assert.equal(manager.listLogs(bot.id).some(entry => entry.message.includes('连续失败')), false)
})

test('clean exits from older smart runtimes remain compatible with in-game restart', async () => {
  const bot = { id: 'bot-legacy-restart', accountId: 'account-legacy', mode: 'smart', desiredState: 'running', runtimeState: 'online', lastError: '' }
  const db = {
    getBot: () => ({ ...bot }),
    updateBotRuntime: (id, fields) => Object.assign(bot, fields)
  }
  const manager = new BotManager(db, {})
  const state = { child: {}, accountId: bot.accountId, protocolIndex: 0, billingMode: 'hourly', stopping: false, disconnectPending: false }
  manager.processes.set(bot.id, state)
  let launched = null
  manager.launchAttempt = current => { launched = current }

  manager.handleExit(bot.id, state, 0, null)
  await new Promise(resolve => setTimeout(resolve, 650))
  assert.equal(launched.id, bot.id)
  assert.equal(manager.accountReconnects.has(bot.accountId), false)
  assert.equal(bot.lastError, '')
})

test('in-game restart command prepares the supervisor before scheduling process exit', async () => {
  const bot = { username: 'PlatformBot', chat: message => chats.push(message) }
  const chats = []
  const requests = []
  let scheduled = 0
  const handler = createSmartCommandHandler(bot, {
    commandPrefixes: ['PlatformBot'],
    platform: {
      request: async (action, payload) => {
        requests.push({ action, payload })
        if (action === 'access') return { blacklisted: false, whitelisted: true, admin: true, lock: { locked: false, adminLocked: false } }
        if (action === 'runtime_version') return { version: '1.0.19' }
        if (action === 'runtime_restart_prepare') return { allowed: true }
        throw new Error(`unexpected action ${action}`)
      }
    },
    scheduleRestart: callback => {
      assert.equal(typeof callback, 'function')
      scheduled += 1
    }
  })

  await handler({ username: 'RootPlayer', message: 'PlatformBot重启' })
  assert.deepEqual(requests.map(row => row.action), ['access', 'runtime_version', 'runtime_restart_prepare'])
  assert.deepEqual(requests.at(-1).payload, { username: 'RootPlayer' })
  assert.equal(chats.at(-1), '机器人正在重启。')
  assert.equal(scheduled, 1)
})

test('in-game runtime control commands never send chat feedback', async () => {
  const chats = []
  const logs = []
  const outcomes = [
    { allowed: true, status: 'starting' },
    { allowed: true, status: 'stopping' },
    { allowed: true, status: 'already_online' },
    { allowed: true, status: 'already_offline' },
    { allowed: false },
    new Error('platform unavailable')
  ]
  const handler = createSmartCommandHandler({ username: 'PlatformBot', chat: message => chats.push(message) }, {
    commandPrefixes: ['PlatformBot'],
    platform: {
      log: message => logs.push(message),
      request: async action => {
        if (action === 'access') return { blacklisted: false, whitelisted: true, admin: true, lock: { locked: false, adminLocked: false } }
        if (action === 'runtime_control') {
          const outcome = outcomes.shift()
          if (outcome instanceof Error) throw outcome
          return outcome
        }
        throw new Error(`unexpected action ${action}`)
      }
    }
  })

  for (const command of ['上线', '下线', '上线', '下线', '上线', '下线']) {
    await handler({ username: 'RootPlayer', message: `PlatformBot${command}` })
  }

  assert.deepEqual(chats, [])
  assert.equal(logs.some(message => message.includes('platform unavailable')), true)
})

test('online smart bots silently relay runtime control for another bot', async () => {
  const bot = new EventEmitter()
  bot.username = 'RelayBot'
  const chats = []
  const logs = []
  const outcomes = [
    { allowed: true, status: 'starting' },
    { allowed: true, status: 'stopping' },
    { allowed: true, status: 'already_online' },
    { allowed: true, status: 'already_offline' },
    new Error('relay unavailable')
  ]
  let finishAttempts
  const attemptsFinished = new Promise(resolve => { finishAttempts = resolve })
  const platform = {
    log: message => logs.push(message),
    request: async action => {
      if (action === 'settings') return { commandPrefix: 'RelayBot', messageOverrides: {}, topUp: {} }
      if (action === 'volatile_schedules_reset') return {}
      if (action === 'runtime_targets') {
        return [{
          id: 'offline-bot',
          serverHost: String(process.env.BOT_PLATFORM_SERVER_HOST || ''),
          serverPort: Number(process.env.BOT_PLATFORM_SERVER_PORT || 25565),
          prefixes: ['OfflineBot']
        }]
      }
      if (action === 'runtime_control') {
        const outcome = outcomes.shift()
        if (!outcomes.length) finishAttempts()
        if (outcome instanceof Error) throw outcome
        return outcome
      }
      throw new Error(`unexpected action ${action}`)
    }
  }
  bot.chat = message => chats.push(message)
  const inertScheduler = { applySettings: () => {}, start: async () => {}, stop: () => {} }
  const remove = installSmartCommands(bot, {
    platform,
    ominousScheduler: inertScheduler,
    periodicRightClickScheduler: inertScheduler,
    fishingController: inertScheduler
  })
  try {
    for (let index = 0; index < 5; index += 1) {
      bot.emit('botPlatformMessage', { username: `Root${index}`, message: `OfflineBot${index % 2 ? '下线' : '上线'}`, channel: 'public' })
    }
    await attemptsFinished
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(chats, [])
    assert.equal(logs.some(message => message.includes('relay unavailable')), true)
  } finally {
    remove()
  }
})

test('version command reports the running version before the latest release details', async () => {
  const chats = []
  const handler = createSmartCommandHandler({ username: 'PlatformBot', chat: message => chats.push(message) }, {
    commandPrefixes: ['PlatformBot'],
    platform: {
      request: async action => {
        if (action === 'access') return { blacklisted: false, whitelisted: true, admin: false, lock: { locked: false, adminLocked: false } }
        if (action === 'runtime_version') return { version: '1.0.27', release: { summary: '下一版更新说明' } }
        throw new Error(`unexpected action ${action}`)
      }
    }
  })

  await handler({ username: 'White', message: 'PlatformBot版本' })

  assert.deepEqual(chats, [
    '智能 Bot 当前运行版本：v1.0.26',
    '智能 Bot 最新版本：v1.0.27；更新内容：下一版更新说明'
  ])
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

test('custom task waits allow up to 28800gt between commands', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('task_owner', 'password-123')
    const bot = f.db.createBot(user.id, { mode: 'smart', label: 'Smart', microsoftEmail: 'task-owner@example.com', serverHost: 'localhost' })
    const saved = f.db.setSmartBotTask(bot.id, {
      name: 'long_wait',
      steps: [
        { type: 'command', command: '切换', args: ['1'] },
        { type: 'wait', ticks: 28800 },
        { type: 'command', command: '切换', args: ['2'] }
      ]
    })
    assert.equal(saved.steps[1].ticks, 28800)
    assert.throws(() => f.db.setSmartBotTask(bot.id, {
      name: 'too_long_wait',
      steps: [
        { type: 'command', command: '切换', args: ['1'] },
        { type: 'wait', ticks: 28801 },
        { type: 'command', command: '切换', args: ['2'] }
      ]
    }), /1-28800gt/)
  } finally {
    f.close()
  }
})

test('custom task parameters are validated, persisted, and saved with scheduled arguments', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('parameter_task_owner', 'password-123')
    const bot = f.db.createBot(user.id, { mode: 'smart', label: 'Smart', microsoftEmail: 'parameter-task@example.com', serverHost: 'localhost' })
    const saved = f.db.setSmartBotTask(bot.id, {
      name: '自动放置',
      parameters: ['x', 'y', 'z'],
      steps: [
        { type: 'command', command: '放置', args: ['{x}', '{y}', '{z}'] },
        { type: 'wait', ticks: 1 },
        { type: 'command', command: '指令', args: ['say', '当前放置点在({x},{y},{z})'] }
      ]
    })
    assert.deepEqual(saved.parameters, ['x', 'y', 'z'])
    assert.deepEqual(saved.scheduleArgs, [])
    assert.equal(saved.schedulePersistent, false)
    assert.throws(() => f.db.scheduleSmartBotTask(bot.id, saved.name, 20, ['100', '64']), /需要 3 个参数/)
    const scheduled = f.db.scheduleSmartBotTask(bot.id, saved.name, 20, ['100', '64', '-200'])
    assert.deepEqual(scheduled.scheduleArgs, ['100', '64', '-200'])
    const stopped = f.db.scheduleSmartBotTask(bot.id, saved.name, null)
    assert.equal(stopped.intervalTicks, null)
    assert.deepEqual(stopped.scheduleArgs, [])
    assert.throws(() => f.db.setSmartBotTask(bot.id, {
      name: '未声明参数',
      parameters: ['x'],
      steps: [{ type: 'command', command: '指令', args: ['say', '{missing}'] }]
    }), /未声明的参数/)
  } finally {
    f.close()
  }
})

test('custom task schedule persistence is opt-in across Bot and platform restarts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-persistent-task-'))
  const config = { databasePath: path.join(root, 'data.sqlite'), sessionDays: 30 }
  let db = new PlatformDb(config)
  try {
    const user = db.createUser('persistent_task_owner', 'password-123')
    const bot = db.createBot(user.id, { mode: 'smart', label: 'Smart', microsoftEmail: 'persistent-task@example.com', serverHost: 'localhost' })
    const steps = [{ type: 'command', command: '切换', args: ['1'] }]
    const volatile = db.setSmartBotTask(bot.id, { name: '临时任务', steps })
    const persistent = db.setSmartBotTask(bot.id, { name: '持久任务', schedulePersistent: true, steps })
    assert.equal(volatile.schedulePersistent, false)
    assert.equal(persistent.schedulePersistent, true)

    db.scheduleSmartBotTask(bot.id, volatile.name, 20)
    const scheduledPersistent = db.scheduleSmartBotTask(bot.id, persistent.name, 40)
    const persistentDueAt = scheduledPersistent.nextDueAt

    db.close()
    db = new PlatformDb(config)
    assert.equal(db.getSmartBotTask(bot.id, volatile.name).intervalTicks, 20)
    assert.equal(db.getSmartBotTask(bot.id, persistent.name).nextDueAt, persistentDueAt)

    const restarted = db.resetSmartBotVolatileSchedules(bot.id).tasks
    const resetVolatile = restarted.find(task => task.name === volatile.name)
    const keptPersistent = restarted.find(task => task.name === persistent.name)
    assert.equal(resetVolatile.intervalTicks, null)
    assert.deepEqual(resetVolatile.scheduleArgs, [])
    assert.equal(keptPersistent.intervalTicks, 40)
    assert.equal(keptPersistent.nextDueAt, persistentDueAt)
    assert.equal(keptPersistent.schedulePersistent, true)
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Bot owners can save forwarded commands in custom tasks', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('forward_task_owner', 'password-123')
    const bot = f.db.createBot(user.id, { mode: 'smart', label: 'Smart', microsoftEmail: 'forward-task@example.com', serverHost: 'localhost' })
    const saved = f.db.setSmartBotTask(bot.id, {
      name: '转发指令',
      parameters: ['命令'],
      steps: [
        { type: 'command', command: '指令', args: ['/msg', 'Target', 'hello'] },
        { type: 'wait', ticks: 1 },
        { type: 'command', command: '指令', args: ['/pay', 'Target', '1'] },
        { type: 'wait', ticks: 1 },
        { type: 'command', command: '指令', args: ['/gmp'] },
        { type: 'wait', ticks: 1 },
        { type: 'command', command: '指令', args: ['/sethome', 'base'] },
        { type: 'wait', ticks: 1 },
        { type: 'command', command: '指令', args: ['{命令}', 'Target', '1'] }
      ]
    })

    assert.deepEqual(saved.steps.filter(step => step.type === 'command').map(step => step.args[0]), ['/msg', '/pay', '/gmp', '/sethome', '{命令}'])
    assert.throws(() => f.db.setSmartBotTask(bot.id, {
      name: '空指令',
      steps: [{ type: 'command', command: '指令', args: [] }]
    }), /指令内容无效/)
    assert.throws(() => f.db.setSmartBotTask(bot.id, {
      name: '超长指令',
      steps: [{ type: 'command', command: '指令', args: ['x'.repeat(257)] }]
    }), /指令内容无效/)
    assert.throws(() => f.db.setSmartBotTask(bot.id, {
      name: '换行指令',
      steps: [{ type: 'command', command: '指令', args: ['say hello\n/pay Target 1'] }]
    }), /指令内容无效/)
  } finally {
    f.close()
  }
})

test('custom task accepts all commands exposed by the task editor', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('task_editor_commands_owner', 'password-123')
    const bot = f.db.createBot(user.id, { mode: 'smart', label: 'Smart', microsoftEmail: 'task-editor-commands@example.com', serverHost: 'localhost' })
    const saved = f.db.setSmartBotTask(bot.id, {
      name: '拿出测试',
      parameters: ['玩家'],
      steps: [
        { type: 'command', command: '拿出', args: ['石头'] },
        { type: 'wait', ticks: 1 },
        { type: 'command', command: '丢弃', args: ['圆石'] },
        { type: 'wait', ticks: 1 },
        { type: 'command', command: '副手', args: [] },
        { type: 'wait', ticks: 1 },
        { type: 'command', command: '攻击', args: [] },
        { type: 'wait', ticks: 1 },
        { type: 'command', command: '移动', args: ['东', '5'] },
        { type: 'wait', ticks: 1 },
        { type: 'command', command: '注视', args: ['{玩家}'] }
      ]
    })
    assert.deepEqual(saved.steps.map(step => step.type === 'command' ? step.command : step.type), ['拿出', 'wait', '丢弃', 'wait', '副手', 'wait', '攻击', 'wait', '移动', 'wait', '注视'])
  } finally {
    f.close()
  }
})

test('custom task storage accepts cursor right click and placement targets', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('cursor_task_owner', 'password-123')
    const bot = f.db.createBot(user.id, { mode: 'smart', label: 'Cursor', microsoftEmail: 'cursor-task@example.com', serverHost: 'localhost' })
    const saved = f.db.setSmartBotTask(bot.id, {
      name: '准星操作',
      steps: [
        { type: 'command', command: '右键', args: ['准星'] },
        { type: 'wait', ticks: 1 },
        { type: 'command', command: '放置', args: ['准星'] }
      ]
    })
    assert.deepEqual(saved.steps, [
      { type: 'command', command: '右键', args: ['准星'] },
      { type: 'wait', ticks: 1 },
      { type: 'command', command: '放置', args: ['准星'] }
    ])
  } finally {
    f.close()
  }
})

test('custom task moves the held item to the off-hand', async () => {
  const heldItem = { name: 'shield', count: 1, slot: 36 }
  const equips = []
  const bot = {
    entity: {},
    inventory: {},
    heldItem,
    equip: async (item, destination) => equips.push({ item, destination })
  }
  const result = await executeCustomTask(bot, {
    name: '举盾',
    steps: [{ type: 'command', command: '副手', args: [] }]
  })

  assert.deepEqual(result.failures, [])
  assert.deepEqual(equips, [{ item: heldItem, destination: 'off-hand' }])
})

test('custom task attacks the entity under the crosshair and a miss swings once', async () => {
  const target = { id: 23, type: 'mob', name: 'zombie' }
  const calls = []
  let cursorTarget = target
  const bot = {
    entity: {},
    entityAtCursor: distance => { calls.push({ type: 'cursor', distance }); return cursorTarget },
    attack: attacked => calls.push({ type: 'attack', target: attacked }),
    swingArm: hand => calls.push({ type: 'swing', hand })
  }

  const result = await executeCustomTask(bot, {
    name: '挥剑',
    steps: [{ type: 'command', command: '攻击', args: [] }]
  })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(calls, [{ type: 'cursor', distance: 3.5 }, { type: 'attack', target }])

  cursorTarget = null
  calls.length = 0
  assert.deepEqual(await attackAtCursor(bot), { status: 'miss', target: null })
  assert.deepEqual(calls, [{ type: 'cursor', distance: 3.5 }, { type: 'swing', hand: 'right' }])
})

test('custom task breaks the block under the crosshair', async () => {
  const block = { name: 'stone', position: new Vec3(3, 64, 3), face: 1, intersect: new Vec3(3.5, 64.5, 3.5) }
  const calls = []
  const bot = {
    entity: {},
    blockAtCursor: distance => { calls.push({ type: 'cursor', distance }); return block },
    dig: async dug => calls.push({ type: 'dig', block: dug })
  }

  const result = await executeCustomTask(bot, {
    name: '挖矿',
    steps: [{ type: 'command', command: '挖掘', args: ['准星'] }]
  })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(calls, [{ type: 'cursor', distance: 4.5 }, { type: 'dig', block }])
})

test('smart attack command performs one native crosshair attack', async () => {
  const target = { id: 31, type: 'player', username: 'Target' }
  const chats = []
  const attacks = []
  const swings = []
  let cursorTarget = target
  const bot = {
    username: 'PlatformBot',
    entity: {},
    chat: message => chats.push(message),
    entityAtCursor: distance => { assert.equal(distance, 3.5); return cursorTarget },
    attack: entity => attacks.push(entity),
    swingArm: hand => swings.push(hand)
  }
  const handler = createSmartCommandHandler(bot, {
    commandPrefixes: ['PlatformBot'],
    getMessageOverrides: () => ({ attackSuccess: '/msg {sender} 已攻击准星目标' }),
    platform: {
      request: async action => {
        if (action === 'access') return { blacklisted: false, whitelisted: true, admin: false, lock: { locked: false, adminLocked: false } }
        if (action === 'task_get') return { task: null }
        throw new Error(`unexpected action ${action}`)
      }
    },
    scheduleRestart: () => {}
  })

  await handler({ username: 'White', message: 'PlatformBot攻击 多余参数' })
  assert.equal(chats.pop(), '正确格式: 攻击')
  assert.deepEqual(attacks, [])

  await handler({ username: '#White', message: 'PlatformBot攻击' })
  assert.deepEqual(attacks, [target])
  assert.equal(chats.pop(), '/msg White 已攻击准星目标')

  cursorTarget = null
  await handler({ username: 'White', message: 'PlatformBot攻击' })
  assert.deepEqual(swings, ['right'])
  assert.equal(chats.pop(), '准星方向没有可攻击目标，已挥动主手。')
})

test('smart dig command digs the crosshair block or a coordinate block', async () => {
  const chats = []
  const dug = []
  const cursorBlock = { name: 'stone', position: new Vec3(10, 64, 20), face: 1, intersect: new Vec3(10.5, 64.5, 20.5) }
  const coordinateBlock = { name: 'dirt', position: new Vec3(0, 64, 0), diggable: true }
  const undiggableBlock = { name: 'bedrock', position: new Vec3(1, 64, 1), diggable: false }
  const bot = {
    username: 'PlatformBot',
    entity: {},
    chat: message => chats.push(message),
    blockAtCursor: distance => { assert.equal(distance, 4.5); return cursorBlock },
    blockAt: position => {
      const key = `${position.x},${position.y},${position.z}`
      if (key === '0,64,0') return coordinateBlock
      if (key === '1,64,1') return undiggableBlock
      return null
    },
    dig: async block => dug.push(block)
  }
  const handler = createSmartCommandHandler(bot, {
    commandPrefixes: ['PlatformBot'],
    platform: {
      request: async action => {
        if (action === 'access') return { blacklisted: false, whitelisted: true, admin: false, lock: { locked: false, adminLocked: false } }
        if (action === 'task_get') return { task: null }
        throw new Error(`unexpected action ${action}`)
      }
    },
    scheduleRestart: () => {}
  })

  await handler({ username: 'White', message: 'PlatformBot挖掘 多余参数' })
  assert.equal(chats.pop(), '正确格式: 挖掘 准星，或 挖掘 x y z。')
  assert.deepEqual(dug, [])

  await handler({ username: 'White', message: 'PlatformBot挖掘 准星' })
  assert.deepEqual(dug, [cursorBlock])
  assert.equal(chats.pop(), '挖掘成功。')

  await handler({ username: 'White', message: 'PlatformBot挖掘 0 64 0' })
  assert.deepEqual(dug, [cursorBlock, coordinateBlock])
  assert.equal(chats.pop(), '挖掘成功。')

  await handler({ username: 'White', message: 'PlatformBot挖掘 1 64 1' })
  assert.equal(chats.pop(), '该方块无法被破坏。')

  await handler({ username: 'White', message: 'PlatformBot挖掘 2 64 2' })
  assert.equal(chats.pop(), '目标位置没有可破坏的方块。')
})

test('editing a custom task updates and renames it without overwriting another task', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('task_edit_owner', 'password-123')
    const bot = f.db.createBot(user.id, { mode: 'smart', label: 'Smart', microsoftEmail: 'task-edit@example.com', serverHost: 'localhost' })
    f.db.setSmartBotTask(bot.id, { name: '旧任务', steps: [{ type: 'command', command: '切换', args: ['1'] }] })
    f.db.setSmartBotTask(bot.id, { name: '保留任务', steps: [{ type: 'command', command: '切换', args: ['9'] }] })

    const edited = f.db.setSmartBotTask(bot.id, {
      originalName: '旧任务',
      name: '新任务',
      parameters: ['格'],
      steps: [{ type: 'command', command: '切换', args: ['{格}'] }]
    })

    assert.equal(f.db.getSmartBotTask(bot.id, '旧任务'), null)
    assert.equal(edited.name, '新任务')
    assert.deepEqual(edited.parameters, ['格'])
    assert.throws(() => f.db.setSmartBotTask(bot.id, {
      originalName: '新任务',
      name: '保留任务',
      steps: [{ type: 'command', command: '副手', args: [] }]
    }), /已存在/)
    assert.equal(f.db.getSmartBotTask(bot.id, '新任务').name, '新任务')
    assert.deepEqual(f.db.getSmartBotTask(bot.id, '保留任务').steps[0].args, ['9'])
  } finally {
    f.close()
  }
})

test('custom task discards every stack matching a Chinese item name parameter', async () => {
  let inventoryItems = [
    { name: 'stone', count: 32, slot: 9 },
    { name: 'dirt', count: 5, slot: 10 },
    { name: 'stone', count: 3, slot: 11 }
  ]
  const dropped = []
  const bot = {
    entity: {},
    inventory: { items: () => inventoryItems },
    tossStack: async item => {
      dropped.push(item)
      inventoryItems = inventoryItems.filter(row => row !== item)
    }
  }
  const result = await executeCustomTask(bot, {
    name: '按名称丢弃',
    parameters: ['物品'],
    steps: [{ type: 'command', command: '丢弃', args: ['{物品}'] }]
  }, { args: ['石头'] })

  assert.deepEqual(result.failures, [])
  assert.deepEqual(dropped.map(item => item.count), [32, 3])
  assert.deepEqual(inventoryItems.map(item => item.name), ['dirt'])
})

test('official Chinese item names resolve to Minecraft item ids', () => {
  assert.equal(normalizeItemId('石头'), 'minecraft:stone')
  assert.equal(normalizeItemId('钻石'), 'minecraft:diamond')
  assert.equal(normalizeItemId('stone'), 'minecraft:stone')
  assert.equal(normalizeItemId('minecraft:stone'), 'minecraft:stone')
})

test('custom task parameters interpolate inside every command argument', async () => {
  const placed = []
  const chats = []
  const bot = {
    entity: {},
    heldItem: { name: 'oak_sapling' },
    blockAt: position => position.x === 100 && position.y === 63 && position.z === 200
      ? { name: 'dirt', boundingBox: 'block', position }
      : { name: 'air', boundingBox: 'empty', position },
    placeBlock: async (reference, face) => placed.push({ reference: reference.position, face }),
    chat: message => chats.push(message)
  }
  const task = {
    name: '自动放置',
    parameters: ['x', 'y', 'z'],
    steps: [
      { type: 'command', command: '放置', args: ['{x}', '{y}', '{z}'] },
      { type: 'wait', ticks: 1 },
      { type: 'command', command: '指令', args: ['say', '当前放置点在({x},{y},{z})'] }
    ]
  }
  const result = await executeCustomTask(bot, task, { args: ['100', '64', '200'] })
  assert.deepEqual(result.failures, [])
  assert.equal(placed.length, 1)
  assert.deepEqual(chats, ['say 当前放置点在(100,64,200)'])

  const contentTask = { name: '自动喊话', parameters: ['内容'], steps: [{ type: 'command', command: '指令', args: ['say', '{内容}'] }] }
  assert.deepEqual(bindTaskArguments(contentTask, ['大家好', '欢迎回来']), { 内容: '大家好 欢迎回来' })
  await executeCustomTask(bot, contentTask, { args: ['大家好', '欢迎回来'] })
  assert.equal(chats.pop(), 'say 大家好 欢迎回来')
})

test('custom tasks execute owner-authored forwarded commands after parameter interpolation', async () => {
  const chats = []
  const bot = { chat: message => chats.push(message) }
  const commands = ['pay', 'msg', 'gmp', 'home', 'sethome']

  for (const command of commands) {
    const result = await executeCustomTask(bot, {
      name: '动态指令',
      parameters: ['命令'],
      steps: [{ type: 'command', command: '指令', args: ['/{命令}', 'Target', '1'] }]
    }, { args: [command] })
    assert.deepEqual(result.failures, [])
  }

  assert.deepEqual(chats, commands.map(command => `/${command} Target 1`))

  for (const args of [[], ['x'.repeat(257)], ['say hello\n/pay Target 1']]) {
    const result = await executeCustomTask(bot, {
      name: '无效指令',
      steps: [{ type: 'command', command: '指令', args }]
    }, { logger: { warn: () => {} } })
    assert.equal(result.failures.length, 1)
  }

  assert.equal(chats.length, commands.length)
})

test('custom task continues with later commands after one command fails', async () => {
  const slots = []
  const warnings = []
  const bot = {
    setQuickBarSlot: async slot => {
      slots.push(slot)
      if (slot === 1) throw new Error('slot unavailable')
    }
  }
  const result = await executeCustomTask(bot, {
    name: 'continue_after_failure',
    steps: [
      { type: 'command', command: '切换', args: ['1'] },
      { type: 'wait', ticks: 1 },
      { type: 'command', command: '切换', args: ['2'] },
      { type: 'wait', ticks: 1 },
      { type: 'command', command: '切换', args: ['3'] }
    ]
  }, { logger: { warn: message => warnings.push(message) } })

  assert.deepEqual(slots, [0, 1, 2])
  assert.deepEqual(result.failures, [{ commandIndex: 2, command: '切换', message: 'slot unavailable' }])
  assert.match(warnings[0], /第 2 条指令.*slot unavailable/)
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

test('cursor right click and placement preserve the view and exact stair hit point', async () => {
  const block = {
    name: 'oak_stairs',
    position: new Vec3(100, 64, 200),
    intersect: new Vec3(100, 64.25, 200.75),
    face: 5
  }
  const packets = []
  const placements = []
  const cursorRanges = []
  const swings = []
  const bot = {
    entity: {},
    heldItem: { name: 'oak_planks' },
    blockAtCursor: range => {
      cursorRanges.push(range)
      return block
    },
    lookAt: async () => { throw new Error('cursor interaction must not turn the bot') },
    supportFeature: name => name === 'blockPlaceHasInsideBlock',
    _client: { write: (name, packet) => packets.push({ name, packet }) },
    swingArm: hand => swings.push(hand),
    _placeBlockWithOptions: async (reference, face, options) => placements.push({ reference, face, options })
  }

  await rightClickTarget(bot, ['准星'])
  await placeAtCursor(bot)

  assert.equal(packets[0].name, 'block_place')
  assert.deepEqual(packets[0].packet, {
    location: block.position,
    direction: 5,
    hand: 0,
    cursorX: 0,
    cursorY: 0.25,
    cursorZ: 0.75,
    insideBlock: false,
    sequence: 0,
    worldBorderHit: false
  })
  assert.deepEqual(swings, ['right'])
  assert.equal(placements[0].reference, block)
  assert.deepEqual(placements[0].face, new Vec3(1, 0, 0))
  assert.deepEqual(placements[0].options, { swingArm: 'right', forceLook: 'ignore', delta: new Vec3(0, 0.25, 0.75) })
  assert.deepEqual(placements[0].reference.position.plus(placements[0].face), new Vec3(101, 64, 200))
  assert.deepEqual(cursorRanges, [4.5, 4.5])
})

test('cursor placement uses the underside of an upside-down stair instead of a reported side face', async () => {
  const block = {
    name: 'oak_stairs',
    position: new Vec3(100, 64, 200),
    intersect: new Vec3(100.5, 64.5, 200.75),
    face: 5,
    shapes: [
      [0, 0, 0, 1, 1, 0.5],
      [0, 0.5, 0.5, 1, 1, 1]
    ]
  }
  const placements = []
  const bot = {
    entity: {},
    heldItem: { name: 'stone' },
    blockAtCursor: () => block,
    _placeBlockWithOptions: async (reference, face, options) => placements.push({ reference, face, options })
  }

  await placeAtCursor(bot)

  assert.deepEqual(placements[0].face, new Vec3(0, -1, 0))
  assert.deepEqual(placements[0].reference.position.plus(placements[0].face), new Vec3(100, 63, 200))
  assert.deepEqual(placements[0].options.delta, new Vec3(0.5, 0.5, 0.75))

  block.intersect = new Vec3(100.5, 64.25, 200.5)
  block.face = 0
  placements.length = 0
  await placeAtCursor(bot)
  assert.deepEqual(placements[0].face, new Vec3(0, 0, 1))
  assert.deepEqual(placements[0].reference.position.plus(placements[0].face), new Vec3(100, 64, 201))
})

test('custom tasks execute cursor placement and right click without changing the view', async () => {
  const block = { name: 'stone', position: new Vec3(0, 64, 0), intersect: new Vec3(0.5, 65, 0.5), face: 1 }
  const actions = []
  const bot = {
    entity: {},
    heldItem: { name: 'stone' },
    blockAtCursor: () => block,
    supportFeature: name => name === 'blockPlaceHasInsideBlock',
    _client: { write: (name, packet) => actions.push({ type: 'rightClick', target: packet.location }) },
    swingArm: () => {},
    _placeBlockWithOptions: async (reference, face) => actions.push({ type: 'place', target: reference.position.plus(face) })
  }
  const result = await executeCustomTask(bot, {
    name: '准星操作',
    steps: [
      { type: 'command', command: '右键', args: ['准星'] },
      { type: 'wait', ticks: 1 },
      { type: 'command', command: '放置', args: ['准星'] }
    ]
  })

  assert.deepEqual(result.failures, [])
  assert.equal(actions[0].target, block.position)
  assert.deepEqual(actions[1].target, new Vec3(0, 65, 0))
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

test('smart fishing command persists and applies the requested state', async () => {
  const bot = new EventEmitter()
  bot.username = 'PlatformBot'
  const chats = []
  const settings = { fishingEnabled: false, fishingIntervalTicks: 10 }
  bot.chat = message => chats.push(message)
  const handler = createSmartCommandHandler(bot, {
    commandPrefixes: ['PlatformBot'],
    platform: {
      request: async (action, payload) => {
        if (action === 'access') return { blacklisted: false, whitelisted: true, admin: false, lock: { locked: false, adminLocked: false } }
        if (action === 'fishing_schedule_set') {
          settings.fishingEnabled = Boolean(payload.enabled)
          if (settings.fishingEnabled) settings.fishingIntervalTicks = payload.intervalTicks
          return { allowed: true, settings }
        }
        throw new Error(`unexpected action ${action}`)
      }
    },
    applyFishingSettings: next => next
  })

  await handler({ username: 'White', message: 'PlatformBot钓鱼 开 0' })
  assert.match(chats.pop(), /默认间隔 10gt/)
  await handler({ username: 'White', message: 'PlatformBot钓鱼 开 1.5' })
  assert.match(chats.pop(), /默认间隔 10gt/)
  await handler({ username: 'White', message: 'PlatformBot钓鱼 关 10' })
  assert.match(chats.pop(), /默认间隔 10gt/)
  await handler({ username: 'White', message: 'PlatformBot钓鱼 开' })
  assert.equal(settings.fishingEnabled, true)
  assert.equal(settings.fishingIntervalTicks, 10)
  assert.match(chats.pop(), /10gt 重抛/)
  await handler({ username: 'White', message: 'PlatformBot钓鱼 开 20' })
  assert.equal(settings.fishingIntervalTicks, 20)
  assert.match(chats.pop(), /20gt 重抛/)
  await handler({ username: 'White', message: 'PlatformBot钓鱼 关' })
  assert.equal(settings.fishingEnabled, false)
  assert.equal(chats.pop(), '自动钓鱼已关闭。')
})

test('automatic fishing restores its state, uses the configured tick interval, and retracts when disabled', async () => {
  const timers = []
  let casts = 0
  let activations = 0
  let pendingFish
  const bot = {
    entity: {},
    heldItem: { name: 'fishing_rod' },
    fish: () => {
      casts += 1
      return new Promise((resolve, reject) => { pendingFish = { resolve, reject } })
    },
    activateItem: () => {
      activations += 1
      pendingFish?.reject(new Error('Fishing cancelled'))
    }
  }
  const controller = createFishingController(bot, {
    platform: { request: async action => action === 'fishing_schedule_get' ? { fishingEnabled: true, fishingIntervalTicks: 20 } : Promise.reject(new Error(`unexpected action ${action}`)) },
    setTimer: (handler, milliseconds) => { timers.push({ handler, milliseconds }); return { unref () {} } },
    clearTimer: () => {},
    logger: { warn () {} }
  })

  await controller.start()
  assert.equal(controller.getState().enabled, true)
  assert.equal(controller.getState().intervalTicks, 20)
  assert.equal(timers.at(-1).milliseconds, 0)

  const firstCast = controller.runNow()
  assert.equal(casts, 1)
  pendingFish.resolve()
  await firstCast
  assert.equal(timers.at(-1).milliseconds, 1000)

  const secondCast = controller.runNow()
  assert.equal(casts, 2)
  controller.applySettings({ fishingEnabled: false })
  await secondCast
  assert.equal(activations, 1)
  assert.equal(controller.getState().enabled, false)
  controller.stop()
})

test('automatic fishing retracts and retries when Mineflayer never finishes a cast', async () => {
  const timers = []
  const pendingCasts = []
  let casts = 0
  let activations = 0
  const bot = {
    entity: {},
    heldItem: { name: 'fishing_rod' },
    fish: () => {
      casts += 1
      return new Promise(resolve => pendingCasts.push(resolve))
    },
    activateItem: () => { activations += 1 }
  }
  const controller = createFishingController(bot, {
    fishingAttemptTimeoutMs: 5000,
    setTimer: (handler, milliseconds) => {
      const timer = { handler, milliseconds, cleared: false, unref () {} }
      timers.push(timer)
      return timer
    },
    clearTimer: timer => { timer.cleared = true },
    logger: { warn () {} }
  })

  controller.applySettings({ fishingEnabled: true, fishingIntervalTicks: 20 })
  const firstCast = controller.runNow()
  assert.equal(casts, 1)
  const watchdog = timers.at(-1)
  assert.equal(watchdog.milliseconds, 5000)

  watchdog.handler()
  await firstCast
  assert.equal(activations, 1)
  assert.equal(controller.getState().running, false)
  const retry = timers.at(-1)
  assert.equal(retry.milliseconds, 1000)

  const secondCast = retry.handler()
  assert.equal(casts, 2)
  pendingCasts.at(-1)()
  await secondCast
  controller.stop()
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

    const fishing = manager.executeSmartRequest(bot.id, 'fishing_schedule_set', { username: 'Alice', enabled: true, intervalTicks: 40 })
    assert.equal(fishing.allowed, true)
    assert.equal(manager.executeSmartRequest(bot.id, 'fishing_schedule_get', {}).fishingEnabled, true)
    assert.equal(manager.executeSmartRequest(bot.id, 'fishing_schedule_get', {}).fishingIntervalTicks, 40)
    const scheduleLogs = manager.listRelatedLogs(bot.id)
    assert.equal(scheduleLogs.some(entry => entry.message.includes('玩家 Alice 开启了定时任务「定时放置」')), true)
    assert.equal(scheduleLogs.some(entry => entry.message.includes('玩家 Alice 开启了定时任务「定时灾厄之瓶」')), true)
    assert.equal(scheduleLogs.some(entry => entry.message.includes('玩家 Alice 开启了定时任务「自动钓鱼」')), true)

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
  let vaultAutoOpenSettings = { vaultAutoOpenEnabled: false }
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
      if (action === 'vault_auto_open_set') {
        vaultAutoOpenSettings = { ...vaultAutoOpenSettings, vaultAutoOpenEnabled: payload.enabled }
        return { allowed: true, settings: vaultAutoOpenSettings }
      }
      if (action === 'task_get') {
        if (payload.name === '单次任务') return { task: { name: '单次任务', parameters: ['格'], steps: [{ type: 'command', command: '切换', args: ['{格}'] }] } }
        if (payload.name === '放置') return { task: { name: '放置', parameters: ['x', 'y', 'z'], steps: [{ type: 'command', command: '指令', args: ['say', '当前放置点在({x},{y},{z})'] }] } }
        return { task: null }
      }
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
    scheduleRestart: () => {},
    applyVaultAutoOpenSettings: next => next
  })

  await handler({ username: 'Guest', message: '@near' })
  assert.deepEqual(chats, [])
  await handler({ username: 'Guest', message: 'PlatformBot版本' })
  assert.deepEqual(chats, [])
  await handler({ username: 'White', message: 'PlatformBot版本' })
  assert.equal(chats.pop(), '智能 Bot 当前运行版本：v1.0.26')
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
  await handler({ username: 'White', message: 'PlatformBot开宝库' })
  assert.match(chats.pop(), /正确格式: 开宝库 开，或 开宝库 关。/)
  await handler({ username: 'White', message: 'PlatformBot开宝库 开' })
  assert.equal(vaultAutoOpenSettings.vaultAutoOpenEnabled, true)
  assert.match(chats.pop(), /自动开宝库已开启/)
  await handler({ username: 'White', message: 'PlatformBot开宝库 关' })
  assert.equal(vaultAutoOpenSettings.vaultAutoOpenEnabled, false)
  assert.equal(chats.pop(), '自动开宝库已关闭。')
  await handler({ username: 'White', message: 'PlatformBot切换 9' })
  assert.equal(quickBarSlot, 8)
  assert.match(chats.pop(), /第 9 格/)
  await handler({ username: 'White', message: 'PlatformBot单次任务 2' })
  assert.equal(quickBarSlot, 1)
  assert.equal(requests.some(row => row.action === 'task_get' && row.payload.name === '单次任务'), true)
  await handler({ username: 'White', message: 'PlatformBot单次任务' })
  assert.equal(chats.pop(), '正确格式: 单次任务 格')
  await handler({ username: 'White', message: 'PlatformBot放置 100 64 200' })
  assert.equal(chats.pop(), 'say 当前放置点在(100,64,200)')
  await handler({ username: 'White', message: 'PlatformBot清空' })
  assert.equal(inventoryItems.length, 0)
  assert.match(chats.pop(), /2 组、37 个/)
  await handler({ username: 'White', message: 'PlatformBot定时灾厄之瓶 开' })
  assert.equal(ominousSettings.ominousBottleEnabled, true)
  assert.match(chats.pop(), /已开启/)
  await handler({ username: 'White', message: 'custom-prefix-指令 /pay Root 1' })
  assert.match(chats.pop(), /高风险/)
  await handler({ username: 'Root', message: 'custom-prefix-指令 /pay White 1' })
  assert.equal(chats.pop(), '/pay White 1')
  await handler({ username: 'White', message: 'custom-prefix-指令 /home' })
  assert.match(chats.pop(), /home 命令已禁用/)
  await handler({ username: 'Root', message: 'custom-prefix-指令 /home' })
  assert.equal(chats.pop(), '/home')
  await handler({ username: 'Root', message: 'custom-prefix-指令 /sethome base' })
  assert.equal(chats.pop(), '/sethome base')
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

test('smart command can take and discard Chinese-named items, move, and look at players', async () => {
  const bot = new EventEmitter()
  bot.username = 'PlatformBot'
  bot.entity = { position: new Vec3(0, 0, 0) }
  bot.entities = {
    steve: { type: 'player', username: 'Steve', position: new Vec3(4, 0, 0) }
  }
  const chats = []
  const looks = []
  let inventoryItems = [{ name: 'stone', count: 1, slot: 9 }]
  bot.chat = message => chats.push(message)
  bot.inventory = { items: () => inventoryItems }
  const equips = []
  bot.equip = async (item, destination) => { equips.push({ item, destination }); bot.heldItem = item }
  bot.tossStack = async item => { inventoryItems = inventoryItems.filter(row => row !== item) }
  bot.lookAt = async (point, force) => { looks.push({ point, force }) }
  const pathfinderGoalsUsed = []
  bot.pathfinder = {
    setGoal: () => {},
    goto: async goal => {
      pathfinderGoalsUsed.push(goal)
      if (goal instanceof pathfinderGoals.GoalNear) bot.entity.position = new Vec3(goal.x, goal.y, goal.z)
      if (goal instanceof pathfinderGoals.GoalFollow) bot.entity.position = goal.entity.position.clone()
    }
  }
  const handler = createSmartCommandHandler(bot, {
    commandPrefixes: ['PlatformBot'],
    platform: {
      request: async action => {
        if (action === 'access') return { blacklisted: false, whitelisted: true, admin: false, lock: { locked: false, adminLocked: false } }
        if (action === 'runtime_version') return { version: '1.0.12' }
        if (action === 'task_get') return { task: null }
        if (action === 'schedule_status') return { automation: {}, tasks: [] }
        throw new Error(`unexpected action ${action}`)
      }
    },
    scheduleRestart: () => {}
  })

  await handler({ username: 'White', message: 'PlatformBot拿出 石头' })
  assert.equal(equips.at(-1).destination, 'hand')
  assert.equal(chats.pop(), '已将 minecraft:stone 拿到主手。')

  await handler({ username: 'White', message: 'PlatformBot副手' })
  assert.equal(equips.at(-1).destination, 'off-hand')
  assert.equal(chats.pop(), '已将主手的 minecraft:stone 放到副手。')

  const offhandItem = { name: 'shield', count: 1, slot: 45 }
  bot.inventory.slots = []
  bot.inventory.slots[45] = offhandItem
  bot.heldItem = null
  await handler({ username: 'White', message: 'PlatformBot副手' })
  assert.deepEqual(equips.at(-1), { item: offhandItem, destination: 'hand' })
  assert.equal(chats.pop(), '已将副手的 minecraft:shield 放到主手。')

  bot.heldItem = null
  bot.inventory.slots[45] = null
  await handler({ username: 'White', message: 'PlatformBot副手' })
  assert.equal(equips.length, 3)
  assert.equal(chats.pop(), '主手和副手都没有物品。')

  inventoryItems = [{ name: 'stone', count: 32, slot: 9 }, { name: 'dirt', count: 5, slot: 10 }, { name: 'stone', count: 3, slot: 11 }]
  await handler({ username: 'White', message: 'PlatformBot丢弃 石头' })
  assert.equal(chats.pop(), '已丢弃背包中的全部 minecraft:stone，共 2 组、35 个。')
  assert.deepEqual(inventoryItems.map(item => item.name), ['dirt'])
  await handler({ username: 'White', message: 'PlatformBot丢弃 钻石' })
  assert.equal(chats.pop(), '背包中没有 minecraft:diamond。')

  bot.entity.position = new Vec3(0, 0, 0)
  looks.length = 0
  await handler({ username: 'White', message: 'PlatformBot移动 1 0 0' })
  assert.equal(chats.pop(), '已移动到目标附近。')
  assert.equal(pathfinderGoalsUsed.at(-1) instanceof pathfinderGoals.GoalNear, true)
  assert.equal(pathfinderGoalsUsed.at(-1).rangeSq, 0.09)
  assert.equal(bot.entity.position.x, 1)
  assert.equal(bot.entity.position.z, 0)

  bot.entity.position = new Vec3(0, 0, 0)
  looks.length = 0
  await handler({ username: 'White', message: 'PlatformBot移动 Steve' })
  assert.equal(chats.pop(), '已移动到目标附近。')
  assert.equal(pathfinderGoalsUsed.at(-1) instanceof pathfinderGoals.GoalFollow, true)
  assert.equal(pathfinderGoalsUsed.at(-1).entity.username, 'Steve')
  assert.equal(pathfinderGoalsUsed.at(-1).rangeSq, 4)
  assert.equal(bot.entity.position.x, 4)

  await handler({ username: 'White', message: 'PlatformBot注视 Steve' })
  assert.equal(chats.pop(), '已调整视角。')
  assert.equal(looks.at(-1).point.x, 4)
})
