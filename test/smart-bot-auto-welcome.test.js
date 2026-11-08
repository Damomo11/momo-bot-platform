'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { SMART_BOT_VERSION, WELCOME_COMMAND_PATTERN, collectClickCommands, installAutoWelcome } = require('../src/smartBotAutoWelcome')

function fakeBot () {
  const sent = []
  return {
    sent,
    _client: new EventEmitter(),
    chat: text => sent.push(text)
  }
}

test('版本号：v1.0.0，版本说明为新增自动欢迎', () => {
  assert.equal(SMART_BOT_VERSION, '1.0.0')
  assert.match(require('../src/smartBotAutoWelcome').SMART_BOT_CHANGELOG, /自动欢迎/)
})

test('收集按钮命令：老格式 clickEvent + 新格式 click_event + extra 嵌套', () => {
  const old = collectClickCommands({ text: '绑定欢迎', clickEvent: { action: 'run_command', value: '/tsl bindwelcome Damomo1' } })
  assert.deepEqual(old, ['/tsl bindwelcome Damomo1'])
  const modern = collectClickCommands({ text: 'x', click_event: { action: 'run_command', command: '/tsl bindwelcome Damomo1' } })
  assert.deepEqual(modern, ['/tsl bindwelcome Damomo1'])
  const nested = collectClickCommands({
    text: 'root',
    extra: [
      { text: 'a', clickEvent: { action: 'suggest_command', value: '/tsl bindwelcome HayComrade' } },
      { text: 'b', raw: [{ text: 'c', clickEvent: { action: 'open_url', value: 'http://x' } }] },
      { text: 'd', click_event: { action: 'run_command', command: '/tsl bindwelcome etltf' } }
    ]
  })
  assert.deepEqual(nested, ['/tsl bindwelcome HayComrade', '/tsl bindwelcome etltf'])
})

test('自动欢迎：检测到系统消息里的 bindwelcome 按钮即代发，其他命令不动', () => {
  const bot = fakeBot()
  const unload = installAutoWelcome(bot)
  try {
    bot._client.emit('system_chat', {
      contents: { text: '点击绑定欢迎', clickEvent: { action: 'run_command', value: '/tsl bindwelcome Damomo1' } }
    })
    assert.deepEqual(bot.sent, ['/tsl bindwelcome Damomo1'])
    // 无斜杠前缀（1.21.5+ 协议命令不带 /）也能补全代发。
    bot._client.emit('system_chat', {
      contents: { text: 'hi', click_event: { action: 'suggest_command', command: 'tsl bindwelcome HayComrade' } }
    })
    assert.deepEqual(bot.sent, ['/tsl bindwelcome Damomo1', '/tsl bindwelcome HayComrade'])
    // 非欢迎命令不代发。
    bot.sent.length = 0
    bot._client.emit('system_chat', {
      contents: { text: 'go', clickEvent: { action: 'run_command', value: '/tsl somethingelse' } }
    })
    assert.deepEqual(bot.sent, [])
  } finally {
    unload()
  }
})

test('重复推送去重：同一命令短窗内只代发一次', () => {
  const bot = fakeBot()
  const unload = installAutoWelcome(bot)
  try {
    const packet = {
      contents: { text: '欢迎', extra: [{ text: '绑定', clickEvent: { action: 'run_command', value: '/tsl bindwelcome Damomo1' } }] }
    }
    bot._client.emit('system_chat', packet)
    bot._client.emit('system_chat', packet)
    assert.deepEqual(bot.sent, ['/tsl bindwelcome Damomo1'])
  } finally {
    unload()
  }
})

test('卸载后不再响应 system_chat', () => {
  const bot = fakeBot()
  const unload = installAutoWelcome(bot)
  unload()
  bot._client.emit('system_chat', {
    contents: { clickEvent: { action: 'run_command', value: '/tsl bindwelcome Damomo1' } }
  })
  assert.deepEqual(bot.sent, [])
})

test('按钮命令正则：匹配大小写与空白变体，拒绝近似前缀', () => {
  assert.equal(WELCOME_COMMAND_PATTERN.test('/tsl bindwelcome Damomo1'), true)
  assert.equal(WELCOME_COMMAND_PATTERN.test('/TSL BINDWELCOME x'), true)
  assert.equal(WELCOME_COMMAND_PATTERN.test('tsl  bindwelcome y'), true)
  assert.equal(WELCOME_COMMAND_PATTERN.test('/tsl bindwelcome99 z'), false)
  assert.equal(WELCOME_COMMAND_PATTERN.test('/tsl unbindwelcome w'), false)
})
