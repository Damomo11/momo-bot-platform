// 回归测试：26.3 服务器要求每个客户端 tick 末尾收到 serverbound tick_end，
// 否则第二个位置包触发 invalid_player_movement 踢出（mineflayer 上游 #4189）。
// 平台通过 platformPreload 包装 createBot，对所有模板（smart-runtime/signin-runtime）
// 统一注入 tickEndPatch。此处直接验证补丁模块语义 + preload 包装链路。
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { installClientTickEndPatch, MOVEMENT_PACKETS, POSITION_PACKETS } = require('../src/tickEndPatch')

function makeFakeBot () {
  const client = new EventEmitter()
  client.state = 'play'
  const writes = []
  client.write = (name, packet) => { writes.push({ name, packet: packet ?? null }) }
  const bot = new EventEmitter()
  bot._client = client
  return { bot, client, writes }
}

test('physicsTick emits a tick_end and resets the per-tick flag', () => {
  const { bot, client, writes } = makeFakeBot()
  installClientTickEndPatch(bot)
  client.write('position', { x: 1 })
  assert.deepEqual(writes.map(w => w.name), ['position'])
  bot.emit('physicsTick')
  assert.deepEqual(writes.map(w => w.name), ['position', 'tick_end'])
  client.write('position', { x: 2 })
  assert.deepEqual(writes.map(w => w.name), ['position', 'tick_end', 'position'])
})

test('second position packet within one server tick is preceded by a tick_end', () => {
  const { bot, client, writes } = makeFakeBot()
  installClientTickEndPatch(bot)
  // 不经过 physicsTick，模拟 teleport 强制回包与常规回包落在同一事件循环
  client.write('position_look', { x: 1 })
  client.write('position_look', { x: 2 })
  assert.deepEqual(writes.map(w => w.name), ['position_look', 'tick_end', 'position_look'])
})

test('look and flying packets do not trip the position guard', () => {
  const { bot, client, writes } = makeFakeBot()
  installClientTickEndPatch(bot)
  client.write('position', { x: 1 })
  client.write('look', { yaw: 0 })
  client.write('flying', {})
  assert.deepEqual(writes.map(w => w.name), ['position', 'look', 'flying'])
})

test('missing tick_end in older protocol is silently skipped', () => {
  const { bot, client, writes } = makeFakeBot()
  const origWrite = client.write.bind(client)
  client.write = (name, packet) => {
    if (name === 'tick_end') throw new Error('unknown packet tick_end')
    return origWrite(name, packet)
  }
  installClientTickEndPatch(bot)
  bot._client.write('position', { x: 1 })
  bot.emit('physicsTick')
  bot._client.write('position', { x: 2 })
  assert.deepEqual(writes.map(w => w.name), ['position', 'position'])
})

test('uninstall restores the original write function and removes the listener', () => {
  const { bot, client, writes } = makeFakeBot()
  const original = client.write
  const uninstall = installClientTickEndPatch(bot)
  assert.notEqual(client.write, original)
  uninstall()
  assert.equal(client.write, original)
  client.write('position', { x: 3 })
  bot.emit('physicsTick')
  assert.deepEqual(writes.map(w => w.name), ['position'])
})

test('double install returns the existing uninstall and wraps write only once', () => {
  const { bot, client, writes } = makeFakeBot()
  installClientTickEndPatch(bot)
  installClientTickEndPatch(bot)
  client.write('position', { x: 1 })
  bot.emit('physicsTick')
  assert.deepEqual(writes.map(w => w.name), ['position', 'tick_end'])
})

test('physicsTick outside the play state does not send tick_end', () => {
  const { bot, client, writes } = makeFakeBot()
  installClientTickEndPatch(bot)
  client.state = 'configuration'
  bot.emit('physicsTick')
  assert.deepEqual(writes.map(w => w.name), [])
})

test('platformPreload createBot wrapper installs the tick_end patch', async () => {
  // 通过子进程加载 platformPreload 并 require('mineflayer')，验证包装后的 createBot
  // 会对返回的 bot 安装 tick_end 补丁（不真正连服务器，用假 mineflayer 模块）。
  const os = require('node:os')
  const fs = require('node:fs')
  const path = require('node:path')
  const { execFileSync } = require('node:child_process')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preload-test-'))
  const nodeModules = path.join(tmp, 'node_modules')
  const fakeModuleDir = path.join(nodeModules, 'mineflayer')
  fs.mkdirSync(fakeModuleDir, { recursive: true })
  // 假 mineflayer（以裸模块名暴露，platformPreload 只拦截 request === 'mineflayer'）
  fs.writeFileSync(path.join(fakeModuleDir, 'index.js'), `
const { EventEmitter } = require('node:events')
module.exports = {
  createBot: options => {
    const client = new EventEmitter()
    client.state = 'play'
    const writes = []
    client.write = (name, packet) => { writes.push({ name, packet: packet ?? null }) }
    const bot = new EventEmitter()
    bot._client = client
    bot.__writes = writes
    return bot
  }
}
`)
  fs.writeFileSync(path.join(nodeModules, 'mineflayer', 'package.json'), JSON.stringify({
    name: 'mineflayer',
    version: '0.0.0',
    main: 'index.js'
  }))
  // 子进程：--require platformPreload，然后 require('mineflayer') 并 createBot
  fs.writeFileSync(path.join(tmp, 'probe.js'), `
const mineflayer = require('mineflayer')
const bot = mineflayer.createBot({})
bot.emit('physicsTick')
const names = bot.__writes.map(w => w.name)
if (JSON.stringify(names) !== JSON.stringify(['tick_end'])) {
  console.error('unexpected writes: ' + JSON.stringify(names))
  process.exit(1)
}
console.log('PATCH_OK')
`)
  const preloadPath = path.resolve(__dirname, '..', 'src', 'platformPreload.js')
  const out = execFileSync(process.execPath, ['--require', preloadPath, path.join(tmp, 'probe.js')], {
    env: {
      ...process.env,
      NODE_PATH: nodeModules,
      BOT_PLATFORM_SERVER_HOST: '127.0.0.1',
      BOT_PLATFORM_SERVER_PORT: '25565',
      BOT_PLATFORM_MICROSOFT_EMAIL: 'test@example.com',
      BOT_PLATFORM_PROFILES_FOLDER: tmp,
      BOT_PLATFORM_MODULES: '[]',
      BOT_PLATFORM_ACCESS: '{}'
    },
    cwd: tmp
  })
  assert.equal(out.toString().trim(), 'PATCH_OK')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('movement packet sets match mineflayer physics writers', () => {
  assert.deepEqual([...MOVEMENT_PACKETS].sort(), ['flying', 'look', 'position', 'position_look'])
  assert.deepEqual([...POSITION_PACKETS].sort(), ['position', 'position_look'])
})
