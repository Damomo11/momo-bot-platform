const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const PlatformDb = require('../src/db')
const BotManager = require('../src/botManager')
const { environmentForValues, normalizeDefinitions, validateValues } = require('../src/templateVariables')
const { EventEmitter } = require('node:events')
const { installZenoxChatParser } = require('../src/zenoxChatParser')

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

test('users authenticate and sessions resolve', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('player_one', 'password-123')
    assert.equal(f.db.authenticate('player_one', 'password-123').id, user.id)
    const session = f.db.createSession(user.id)
    assert.equal(f.db.getSessionUser(session.token).username, 'player_one')
  } finally { f.close() }
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

test('hourly template prices are deducted precisely once per minute', () => {
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

test('per-run pricing charges only after an explicit success', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('player_once', 'password-123')
    f.db.adjustMomoc(user.id, 3, 'admin_adjust')
    const bot = f.db.createBot(user.id, { templateId: 'idle-login', label: 'Once', microsoftEmail: 'bot@example.com', serverHost: 'localhost' })
    assert.equal(f.db.reserveOnce(bot.id, 4).ok, false)
    assert.equal(f.db.getUser(user.id).momoc, 3)
    assert.equal(f.db.reserveOnce(bot.id, 2).ok, true)
    assert.equal(f.db.getUser(user.id).momoc, 3)
    assert.equal(f.db.getUser(user.id).availableMomoc, 1)
    assert.equal(f.db.chargeOnce(bot.id, 2, 'done').ok, true)
    assert.equal(f.db.getUser(user.id).momoc, 1)
    assert.equal(f.db.getUser(user.id).reservedMomoc, 0)
    const row = f.db.listLedger(user.id).find(entry => entry.kind === 'bot_once')
    assert.equal(row.delta, -2)
    assert.match(row.note, /执行成功/)
  } finally { f.close() }
})

test('a per-run process can report success only once', () => {
  let charges = 0
  const db = {
    chargeOnce: () => { charges++; return { ok: true, balance: 8 } },
    updateBotRuntime: () => {}
  }
  const manager = new BotManager(db, {})
  manager.stop = async () => {}
  const state = { billingMode: 'once', priceMomoc: 2, onceCharged: false, fallbackPending: false }
  manager.handleTemplateSuccess('bot-id', state, 'done')
  manager.handleTemplateSuccess('bot-id', state, 'duplicate')
  assert.equal(charges, 1)
  assert.equal(state.onceCharged, true)
})

test('per-run reservations prevent concurrent overspending and release on failure', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('player_reserve', 'password-123')
    f.db.adjustMomoc(user.id, 2, 'admin_adjust')
    const first = f.db.createBot(user.id, { templateId: 'idle-login', label: 'First', microsoftEmail: 'first@example.com', serverHost: 'localhost' })
    const second = f.db.createBot(user.id, { templateId: 'idle-login', label: 'Second', microsoftEmail: 'second@example.com', serverHost: 'localhost' })
    assert.equal(f.db.reserveOnce(first.id, 2).ok, true)
    assert.equal(f.db.reserveOnce(second.id, 2).ok, false)
    assert.equal(f.db.releaseOnce(first.id, 2), true)
    assert.equal(f.db.reserveOnce(second.id, 2).ok, true)
  } finally { f.close() }
})

test('templates cannot be deleted while bots use them', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('player_three', 'password-123')
    f.db.createBot(user.id, { templateId: 'idle-login', label: 'Idle', microsoftEmail: 'bot@example.com', serverHost: 'localhost' })
    assert.throws(() => f.db.deleteTemplate('idle-login'), /仍被机器人使用/)
  } finally { f.close() }
})

test('template variables are normalized, validated and exposed as environment values', () => {
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

test('one Microsoft account cannot run two template processes at once', async () => {
  const bots = {
    first: { id: 'first', userId: 'user', accountId: 'account', accountAuthState: 'authorized', billingMode: 'hourly', priceMomoc: 0 },
    second: { id: 'second', userId: 'user', accountId: 'account', accountAuthState: 'authorized', billingMode: 'hourly', priceMomoc: 0 }
  }
  const db = {
    getBot: id => bots[id],
    getUser: () => ({ availableMomoc: 0 }),
    updateBotRuntime: () => {}
  }
  const manager = new BotManager(db, {})
  manager.launchAttempt = () => {}
  await manager.start('first')
  await assert.rejects(manager.start('second'), /已有其他模板正在运行/)
})

test('scheduling is restricted to allowed per-run templates', () => {
  const rows = {
    hourly: { id: 'hourly', userId: 'user', billingMode: 'hourly', allowScheduling: false },
    blocked: { id: 'blocked', userId: 'user', billingMode: 'once', allowScheduling: false },
    allowed: { id: 'allowed', userId: 'user', accountId: 'account', billingMode: 'once', allowScheduling: true, scheduleEnabled: false }
  }
  const db = {
    getBot: id => rows[id],
    updateBotSchedule: (id, enabled, scheduleCron) => ({ ...rows[id], scheduleEnabled: enabled, scheduleCron })
  }
  const manager = new BotManager(db, {})
  assert.throws(() => manager.setSchedule('hourly', true, '0 * * * *', 'user'), /不允许定时运行/)
  assert.throws(() => manager.setSchedule('blocked', true, '0 * * * *', 'user'), /不允许定时运行/)
  const saved = manager.setSchedule('allowed', true, '0 * * * *', 'user')
  assert.equal(saved.scheduleEnabled, true)
  manager.removeSchedule('allowed')
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
    assert.deepEqual(accountRow.templateNames, ['仅登录挂机'])
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
  bot.emit('messagestr', '[VIP] PlayerOne » !test', 'chat', null, null)
  bot._client.emit('player_chat', { senderUuid: 'player-uuid', plainMessage: '!test' })
  bot.emit('messagestr', '[PlayerOne ➥ PlatformBot] private text', 'system', null, null)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { username: 'PlayerOne', message: '!test', channel: 'public', source: 'messagestr' })
  assert.deepEqual(rows[1], { username: 'PlayerOne', message: 'private text', channel: 'private', source: 'messagestr' })
})
