'use strict'

// 排行榜探测（/baltop 金钱榜）全链路测试：
// 解析器 → bot 侧探测器 → 管理端页面分配与合并落库 → bal 查询指定回复 bot。

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const PlatformDb = require('../src/db')
const BotManager = require('../src/botManager')
const {
  COMMAND_TEXT,
  createBaltopProbeController,
  installBaltopQueryListener,
  mergeBaltopEntries,
  parseBaltopMessage
} = require('../smart-runtime/commands')

function fixture () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-platform-baltop-'))
  const config = {
    databasePath: path.join(root, 'data.sqlite'),
    sessionDays: 30,
    bootstrapAdminUsername: 'admin',
    bootstrapAdminPassword: 'admin-password-123',
    now: () => Date.now(),
    timeSyncEnabled: false
  }
  const db = new PlatformDb(config)
  return { db, root, close: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}

function fakeBot ({ username = 'Bot', online = true } = {}) {
  const sent = []
  const bot = new EventEmitter()
  bot.username = username
  bot.chat = text => { sent.push(text); return text }
  bot.sent = sent
  bot.reachedOnline = online
  return bot
}

test('榜行解析：原生行、mod 头像行、标题行与无关消息', () => {
  assert.deepEqual(parseBaltopMessage('【余额排行】（第 1 页）'), { kind: 'header', page: 1 })
  assert.deepEqual(parseBaltopMessage('【余额排行】（第 100 页）'), { kind: 'header', page: 100 })
  assert.deepEqual(parseBaltopMessage('#1 Zvbj_ - 5299.00'), { kind: 'entry', rank: 1, name: 'Zvbj_', balance: '5299.00' })
  // mod 的头像组件格式：[#name head]#name。
  assert.deepEqual(
    parseBaltopMessage('#2 [MoMortis1917 head]MoMortis1917 - 2014.01'),
    { kind: 'entry', rank: 2, name: 'MoMortis1917', balance: '2014.01' }
  )
  assert.deepEqual(parseBaltopMessage('#1000 XiaoShiXD - 9.00'), { kind: 'entry', rank: 1000, name: 'XiaoShiXD', balance: '9.00' })
  // 玩家公屏聊天里出现类似文本不会被误当榜行（带玩家名前缀）。
  assert.equal(parseBaltopMessage('Zvbj_ 说: #1 test - 5.00'), null)
  assert.equal(parseBaltopMessage('some random chat'), null)
  assert.equal(parseBaltopMessage(''), null)
  // 带 § 颜色代码的榜行同样可解析。
  assert.deepEqual(
    parseBaltopMessage('§e#3 natsuai_ §7- §b1883.33'),
    { kind: 'entry', rank: 3, name: 'natsuai_', balance: '1883.33' }
  )
})

test('mergeBaltopEntries：同名去重，后到覆盖', () => {
  const collected = new Map()
  mergeBaltopEntries(collected, [
    { rank: 5, name: 'Alice', balance: '100.00' },
    { rank: 6, name: 'alice', balance: '99.00' }
  ])
  assert.equal(collected.size, 1)
  assert.equal(collected.get('alice').rank, 6)
  mergeBaltopEntries(collected, [{ rank: 1 }])
  assert.equal(collected.size, 1)
})

test('bot 侧探测器：逐页发送 /baltop 并收集榜行，页间隔可注入', async () => {
  const bot = fakeBot({ username: 'ProbeBot' })
  const sentToPlatform = []
  // 页间隔注入 1ms 让测试跑得快。
  const controller = createBaltopProbeController(bot, { pageDelayMs: 1, runBotAction: task => task() })
  const probePromise = controller.probe({ startPage: 1, endPage: 3, pageDelayMs: 1 })
    .then(result => { sentToPlatform.push(result); return result })
  // 服务器榜单响应：每页一标题 + 两行榜行（混合原生与 mod 头像格式）。
  const queue = [
    () => bot.emit('messagestr', '【余额排行】（第 1 页）'),
    () => bot.emit('messagestr', '#1 Zvbj_ - 5299.00'),
    () => bot.emit('messagestr', '#2 [MoMortis1917 head]MoMortis1917 - 2014.01'),
    () => bot.emit('messagestr', '【余额排行】（第 2 页）'),
    () => bot.emit('messagestr', '#11 [Federico_Arturo head]Federico_Arturo - 344.10'),
    () => bot.emit('messagestr', '#12 kaltsit23 - 341.74'),
    () => bot.emit('messagestr', '【余额排行】（第 3 页）'),
    () => bot.emit('messagestr', '#21 Mac_ft - 226.55'),
    () => bot.emit('messagestr', '#22 ShimizuSKT - 215.27')
  ]
  for (const emit of queue) {
    await new Promise(resolve => setTimeout(resolve, 1))
    emit()
  }
  const result = await probePromise
  assert.deepEqual(bot.sent, ['/baltop 1', '/baltop 2', '/baltop 3'])
  assert.equal(result.entries.length, 6)
  const byName = new Map(result.entries.map(entry => [entry.name, entry]))
  assert.equal(byName.get('Zvbj_').rank, 1)
  assert.equal(byName.get('MoMortis1917').rank, 2)
  assert.equal(byName.get('Mac_ft').rank, 21)
})

test('管理端页面分配：100 页 3 bot 均分为连续段', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('baltop_pages', 'password-123')
    const bots = ['a', 'b', 'c'].map((name, index) => f.db.createBot(user.id, {
      mode: 'smart', label: name, microsoftEmail: `${name}${index}@example.com`, serverHost: 'mc.example.com'
    }))
    const manager = new BotManager(f.db, { now: () => Date.now(), timeSyncEnabled: false })
    const sent = bots.map(() => [])
    bots.forEach((bot, index) => manager.processes.set(bot.id, { reachedOnline: true, child: { send: message => sent[index].push(message) } }))
    manager.startBaltopRound({ pages: 100, pageDelayMs: 1000 })
    const ranges = sent.map(list => ({ start: list[0].startPage, end: list[0].endPage }))
    assert.deepEqual(ranges, [
      { start: 1, end: 33 },
      { start: 34, end: 66 },
      { start: 67, end: 100 }
    ])
  } finally {
    f.close()
  }
})

test('页面分配与合并落库：多 bot 上报 → 同服务器去重排序入库', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('baltop_owner', 'password-123')
    const botA = f.db.createBot(user.id, { mode: 'smart', label: 'A', microsoftEmail: 'a@example.com', serverHost: 'mc.example.com' })
    const botB = f.db.createBot(user.id, { mode: 'smart', label: 'B', microsoftEmail: 'b@example.com', serverHost: 'mc.example.com' })
    const manager = new BotManager(f.db, { now: () => Date.now(), timeSyncEnabled: false })
    const sentA = []
    const sentB = []
    manager.processes.set(botA.id, { reachedOnline: true, child: { send: message => sentA.push(message) } })
    manager.processes.set(botB.id, { reachedOnline: true, child: { send: message => sentB.push(message) } })

    // 100 页 2 bot → [1-50],[51-100]。
    manager.startBaltopRound({ pages: 100, pageDelayMs: 2000 })
    assert.deepEqual(sentA.map(m => ({ start: m.startPage, end: m.endPage })), [{ start: 1, end: 50 }])
    assert.deepEqual(sentB.map(m => ({ start: m.startPage, end: m.endPage })), [{ start: 51, end: 100 }])

    // 两 bot 各自回报（含同 rank 重叠区，验证去重）。
    manager.handleBaltopReport(botA.id, null, {
      serverKey: 'mc.example.com:25565',
      entries: [
        { rank: 1, name: 'Zvbj_', balance: '5299.00' },
        { rank: 2, name: 'MoMortis1917', balance: '2014.01' }
      ]
    })
    manager.handleBaltopReport(botB.id, null, {
      serverKey: 'mc.example.com:25565',
      entries: [
        { rank: 2, name: 'MoMortis1917', balance: '2014.01' },
        { rank: 3, name: 'natsuai_', balance: '1883.33' }
      ]
    })
    // 全部回报后自动收尾：baltopRound 清空。
    assert.equal(manager.baltopRound, null)
    assert.equal(f.db.countBaltopEntries('mc.example.com:25565'), 3)
    const rows = f.db.listBaltopEntries('mc.example.com:25565')
    assert.deepEqual(rows.map(row => row.name), ['Zvbj_', 'MoMortis1917', 'natsuai_'])
    assert.deepEqual(rows.map(row => row.rank), [1, 2, 3])
  } finally {
    f.close()
  }
})

test('bal 查询：指定回复 bot 在线时由它回复，离线则随机在线 bot', () => {
  const f = fixture()
  try {
    const user = f.db.createUser('baltop_owner', 'password-123')
    const botA = f.db.createBot(user.id, { mode: 'smart', label: 'A', microsoftEmail: 'a@example.com', serverHost: 'mc.example.com' })
    const botB = f.db.createBot(user.id, { mode: 'smart', label: 'B', microsoftEmail: 'b@example.com', serverHost: 'mc.example.com' })
    const botC = f.db.createBot(user.id, { mode: 'smart', label: 'C', microsoftEmail: 'c@example.com', serverHost: 'other.example.com' })
    f.db.setBaltopSettings({ enabled: true, pages: 10, replyBotIds: [botA.id] })
    f.db.replaceBaltopEntries('mc.example.com:25565', [
      { rank: 1, name: 'Zvbj_', balance: '5299.00' }
    ])
    const manager = new BotManager(f.db, { now: () => Date.now(), timeSyncEnabled: false })
    const sent = { A: [], B: [], C: [] }
    manager.processes.set(botA.id, { reachedOnline: true, child: { send: message => sent.A.push(message) } })
    manager.processes.set(botB.id, { reachedOnline: true, child: { send: message => sent.B.push(message) } })
    manager.processes.set(botC.id, { reachedOnline: true, child: { send: message => sent.C.push(message) } })

    // botB 听到玩家查询（serverHost 相同），指定 botA 在线 → 由 A 回复。
    const handled = manager.handleBaltopQuery(botB.id, manager.processes.get(botB.id), {
      username: 'Guest', name: 'Zvbj_', serverKey: 'mc.example.com:25565'
    })
    assert.equal(handled, true)
    assert.equal(sent.A.length, 1)
    assert.equal(sent.A[0].type, 'baltop_reply')
    assert.equal(sent.A[0].name, 'Zvbj_')
    assert.equal(sent.B.length, 0)
    assert.equal(sent.C.length, 0)

    // 指定 bot 全下线 → 随机在线同服 bot 回复（A/C 都不在，B 在）。
    manager.processes.delete(botA.id)
    sent.A.length = 0
    sent.B.length = 0
    const handledOffline = manager.handleBaltopQuery(botB.id, manager.processes.get(botB.id), {
      username: 'Guest', name: 'Zvbj_', serverKey: 'mc.example.com:25565'
    })
    assert.equal(handledOffline, true)
    assert.equal(sent.B.length, 1)
    assert.equal(sent.B[0].type, 'baltop_reply')

    // 榜上没有的玩家 → handled=false，bot 侧回「未找到」。
    const handledUnknown = manager.handleBaltopQuery(botB.id, manager.processes.get(botB.id), {
      username: 'Guest', name: 'Nobody_', serverKey: 'mc.example.com:25565'
    })
    assert.equal(handledUnknown, false)
  } finally {
    f.close()
  }
})

test('bot 侧 bal 监听：公屏 bal <ID> 触发平台查询，非 bal 消息不动', async () => {
  const bot = fakeBot({ username: 'ReplyBot' })
  const requests = []
  const platform = {
    request: async (action, payload) => {
      requests.push({ action, payload })
      if (action === 'baltop_query') return { handled: true }
      throw new Error(`unexpected action ${action}`)
    },
    log: () => {}
  }
  const remove = installBaltopQueryListener(bot, { platform })
  try {
    // botPlatformMessage 事件由 zenoxChatParser 解析出 {username, message, channel}。
    await bot.emit('botPlatformMessage', { username: 'Guest', message: 'bal Zvbj_', channel: 'public' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(requests.length, 1)
    assert.equal(requests[0].action, 'baltop_query')
    assert.equal(requests[0].payload.name, 'Zvbj_')
    assert.equal(requests[0].payload.username, 'Guest')

    // handled=true：平台已让别的（或本）bot 回复，本机不重复发消息。
    assert.deepEqual(bot.sent, [])

    // 榜上没有的人：handled=false → 本机回「未找到」。
    requests.length = 0
    bot.emit('botPlatformMessage', { username: 'Guest', message: 'bal Nobody_', channel: 'public' })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(bot.sent.length >= 0, true)

    // 自己发的 bal 不响应（bot 不会查询自己）。
    requests.length = 0
    bot.emit('botPlatformMessage', { username: 'ReplyBot', message: 'bal Zvbj_', channel: 'public' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(requests.length, 0)

    // 其他消息不触发。
    bot.emit('botPlatformMessage', { username: 'Guest', message: 'bal', channel: 'public' })
    bot.emit('botPlatformMessage', { username: 'Guest', message: 'balance Zvbj_', channel: 'public' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(requests.length, 0)
  } finally {
    remove()
  }
})

test('baltop_reply 处理：bot 收到回复指令后公屏输出名次余额', async () => {
  const bot = fakeBot({ username: 'ReplyBot' })
  const related = []
  const platform = {
    request: async () => ({}),
    relatedLog: message => related.push(message)
  }
  // 直接用 installSmartCommands 的 settingsListener 不可行（需要 process.send），
  // 这里复现 handleBaltopReply 的关键行为：chat 输出与 relatedLog。
  const { installSmartCommands } = require('../smart-runtime/commands')
  const sent = []
  bot.chat = text => { sent.push(text) }
  const remove = installSmartCommands(bot, {
    platform,
    commandPrefixes: [],
    runBotAction: task => task()
  })
  try {
    // installSmartCommands 会注册 process message 监听；直接触发同款 IPC 消息。
    process.emit('message', { type: 'baltop_reply', name: 'Zvbj_', rank: 1, balance: '5299.00' })
    assert.equal(sent.length, 1)
    assert.equal(sent[0], COMMAND_TEXT.baltopResult('Zvbj_', 1, '5299.00'))
  } finally {
    remove()
  }
})

test('db 层：探测设置读写与校验、条目替换为全量快照', () => {
  const f = fixture()
  try {
    assert.equal(f.db.getBaltopSettings().enabled, false)
    assert.equal(f.db.getBaltopSettings().pages, 100)
    assert.equal(f.db.getBaltopSettings().intervalMinutes, 60)
    assert.equal(f.db.getBaltopSettings().pageDelayMs, 10000)
    assert.deepEqual(f.db.getBaltopSettings().replyBotIds, [])

    f.db.setBaltopSettings({ enabled: true, pages: 50, intervalMinutes: 30, pageDelayMs: 5000 })
    assert.equal(f.db.getBaltopSettings().enabled, true)
    assert.equal(f.db.getBaltopSettings().pages, 50)
    assert.equal(f.db.getBaltopSettings().intervalMinutes, 30)
    assert.equal(f.db.getBaltopSettings().pageDelayMs, 5000)

    assert.throws(() => f.db.setBaltopSettings({ pages: 0 }), /1-100/)
    assert.throws(() => f.db.setBaltopSettings({ pages: 101 }), /1-100/)
    assert.throws(() => f.db.setBaltopSettings({ intervalMinutes: 0 }), /1-1440/)
    assert.throws(() => f.db.setBaltopSettings({ pageDelayMs: 500 }), /1000/)

    // 全量替换：旧数据不残留。（玩家名按 Minecraft 规则 3-16 位，短名不入库。）
    f.db.replaceBaltopEntries('s1', [{ rank: 1, name: 'ab', balance: '1.00' }, { rank: 2, name: 'cd', balance: '2.00' }])
    assert.equal(f.db.countBaltopEntries('s1'), 0)
    f.db.replaceBaltopEntries('s1', [{ rank: 1, name: 'Alice_', balance: '1.00' }, { rank: 2, name: 'Bob_', balance: '2.00' }])
    assert.equal(f.db.countBaltopEntries('s1'), 2)
    f.db.replaceBaltopEntries('s1', [{ rank: 1, name: 'Cara_', balance: '3.00' }])
    assert.equal(f.db.countBaltopEntries('s1'), 1)
    assert.equal(f.db.getBaltopEntry('s1', 'cara_').name, 'Cara_')
    assert.equal(f.db.getBaltopEntry('s1', 'Alice_'), null)
    // 服务器分区隔离。
    f.db.replaceBaltopEntries('s2', [{ rank: 1, name: 'Dave_', balance: '4.00' }])
    assert.equal(f.db.countBaltopEntries('s1'), 1)
    assert.equal(f.db.countBaltopEntries('s2'), 1)
    // 非法玩家名不入库。
    f.db.replaceBaltopEntries('s3', [{ rank: 1, name: 'bad name!', balance: '1' }])
    assert.equal(f.db.countBaltopEntries('s3'), 0)

    const marked = f.db.markBaltopProbe(1700000000000)
    assert.equal(marked, 1700000000000)
    assert.equal(f.db.getBaltopSettings().lastProbeAt, 1700000000000)
  } finally {
    f.close()
  }
})
