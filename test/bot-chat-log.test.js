'use strict'

// 聊天文件日志（platformPreload 的 installChatFileLogger）：
// 每 bot 独立文件、收/发方向标记、按天滚动、超上限停写。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

// platformPreload 未导出内部函数，这里从源码中提取安装器在受控环境运行
//（config.root 指向临时目录，与 logger.test.js 同思路）。
function loadInstaller () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'platformPreload.js'), 'utf8')
  const fnSource = src.match(/function installChatFileLogger \(bot\) \{[\s\S]*?\n\}/)
  assert.ok(fnSource, 'platformPreload 应包含 installChatFileLogger')
  const context = vm.createContext({
    require: name => (name === './config' ? { loadConfig: () => ({ root: globalThis.ROOT }) } : require(name)),
    path,
    process: { env: { BOT_PLATFORM_INSTANCE_ID: globalThis.BOT_ID } },
    console: { warn: () => {} }
  })
  vm.runInContext(fnSource[0] + '; globalThis.__install = installChatFileLogger', context)
  return context.__install
}

function fakeBot () {
  const bot = new EventEmitter()
  bot.chat = () => {}
  return bot
}

test('聊天日志：收/发都落盘，每 bot 独立文件，带方向标记', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-chatlog-'))
  globalThis.ROOT = root
  globalThis.BOT_ID = 'abcd1234-5678-9def'
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const install = loadInstaller()
  const bot = fakeBot()
  bot.username = 'ProbeBot_' // 正版名（登录后）
  install(bot)

  bot.emit('message', { toString: () => '【余额排行】（第 1 页）' }, 'system')
  bot.emit('message', { toString: () => 'Zvbj_: hello world' }, 'chat')
  bot.chat('/baltop 1')
  bot.chat('【椰汁橙】玩家 A 的余额为 1.00。')

  const pad = value => String(value).padStart(2, '0')
  const now = new Date()
  const name = `ProbeBot_-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`
  const content = fs.readFileSync(path.join(root, 'logs', 'chat', name), 'utf8')
  assert.match(content, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[收\] 【余额排行】（第 1 页）/)
  assert.match(content, /\[收\] Zvbj_: hello world/)
  assert.match(content, /\[发\] \/baltop 1/)
  assert.match(content, /\[发\] 【椰汁橙】玩家 A 的余额为 1\.00。/)
})

test('聊天日志：文件名用 Minecraft 正版名（登录前的消息缓冲后并入，不再用 botId）', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-chatlog-'))
  globalThis.ROOT = root
  globalThis.BOT_ID = 'ecd04f29-18a3-4329'
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const install = loadInstaller()
  const bot = fakeBot()
  bot.username = '' // 登录前还没有正版名
  install(bot)

  // 登录前的消息：先缓冲，不落盘（不产生 botId 回落文件）。
  bot.emit('message', { toString: () => 'login banner 1' }, 'system')
  bot.emit('message', { toString: () => 'login banner 2' }, 'system')
  assert.equal(bot.username, '')
  const early = fs.existsSync(path.join(root, 'logs', 'chat')) && fs.readdirSync(path.join(root, 'logs', 'chat'))
  assert.equal(early ? early.length : 0, 0, '正版名未定前不应写文件')

  // 登录完成：正版名出现，缓冲整批并入正版名文件。
  bot.username = 'IN_OF_DREAM'
  bot.emit('message', { toString: () => 'Zvbj_: hello' }, 'chat')
  bot.chat('/baltop 1')

  const files = fs.readdirSync(path.join(root, 'logs', 'chat'))
  assert.equal(files.length, 1, '只应有一个文件')
  assert.equal(files[0].startsWith('IN_OF_DREAM-'), true, '文件名应为正版名而非 botId')
  const content = fs.readFileSync(path.join(root, 'logs', 'chat', files[0]), 'utf8')
  assert.match(content, /\[收\] login banner 1/)
  assert.match(content, /\[收\] login banner 2/)
  assert.match(content, /\[收\] Zvbj_: hello/)
  assert.match(content, /\[发\] \/baltop 1/)
})

test('聊天日志：不同 bot 写入不同文件，互不混流', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-chatlog-'))
  globalThis.ROOT = root
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const botA = fakeBot()
  botA.username = 'BotAlpha_'
  loadInstaller()(botA)
  const botB = fakeBot()
  botB.username = 'BotBeta_'
  loadInstaller()(botB)

  botA.emit('message', { toString: () => 'A 收到' }, 'chat')
  botB.emit('message', { toString: () => 'B 收到' }, 'chat')

  const files = fs.readdirSync(path.join(root, 'logs', 'chat')).sort()
  assert.equal(files.length, 2)
  assert.equal(files[0].startsWith('BotAlpha_'), true)
  assert.equal(files[1].startsWith('BotBeta_'), true)
  const a = fs.readFileSync(path.join(root, 'logs', 'chat', files[0]), 'utf8')
  const b = fs.readFileSync(path.join(root, 'logs', 'chat', files[1]), 'utf8')
  assert.match(a, /A 收到/)
  assert.equal(a.includes('B 收到'), false)
  assert.match(b, /B 收到/)
  assert.equal(b.includes('A 收到'), false)
})

test('噪音过滤：PartialReadError 刷屏与 partial packet 同条丢弃（bot 进程 + 守护进程双保险）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'platformPreload.js'), 'utf8')
  const core = fs.readFileSync(path.join(__dirname, '..', 'core-runtime', 'index.js'), 'utf8')
  for (const [name, source] of [['platformPreload', src], ['core-runtime', core]]) {
    const pattern = source.match(/const PROTOCOL_NOISE = (.+)$/m)
    assert.ok(pattern, `${name} 应定义 PROTOCOL_NOISE`)
    const regex = eval(pattern[1])
    // 2026-11-11 实测刷屏：1.21.11 粒子包读越界，单分钟 200+ 条完整堆栈。
    assert.equal(regex.test('PartialReadError: Read error for undefined : undefined'), true, `${name} 应命中 PartialReadError`)
    assert.equal(regex.test('Chunk size is 89 but only 12 was read'), true, `${name} 应保留原 partial packet 过滤`)
    assert.equal(regex.test('partial packet'), true, `${name} 应保留原 partial packet 过滤`)
    // 正常业务日志不能被误杀。
    assert.equal(regex.test('[template:abc] 命令匹配 · Guest: 充值 21'), false, `${name} 不应误杀业务日志`)
    assert.equal(regex.test('[bot:xxx] Runtime state: online'), false, `${name} 不应误杀状态日志`)
  }
})
