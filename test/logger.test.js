'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { installConsoleFileLogger } = require('../src/logger')

function pad (value) { return String(value).padStart(2, '0') }

function fileNameForDate (prefix, date) {
  return `${prefix}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.log`
}

function todayFileName (prefix) {
  return fileNameForDate(prefix, new Date())
}

test('console 落盘：log/warn/error 带时间戳与级别写入当日文件', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-logger-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const uninstall = installConsoleFileLogger({ logDir: dir, prefix: 'test', passthrough: false })
  try {
    console.log('hello', { a: 1 })
    console.warn('warning')
    console.error('boom', 42)
  } finally {
    uninstall()
  }
  const content = fs.readFileSync(path.join(dir, todayFileName('test')), 'utf8')
  assert.match(content, /\[info\] hello \{ a: 1 \}/)
  assert.match(content, /\[warn\] warning/)
  assert.match(content, /\[error\] boom 42/)
  assert.match(content, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[info\]/)
})

test('多行消息逐行补时间戳，方便按时间 grep', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-logger-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const uninstall = installConsoleFileLogger({ logDir: dir, prefix: 'test', passthrough: false })
  try {
    console.log('first line\nsecond line')
  } finally {
    uninstall()
  }
  const lines = fs.readFileSync(path.join(dir, todayFileName('test')), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  for (const line of lines) {
    assert.match(line, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[info\]/)
  }
})

test('启动时清理超过保留期的旧日志，保留期内文件不动', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-logger-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const old = new Date(Date.now() - 40 * 86400000)
  const fresh = new Date(Date.now() - 2 * 86400000)
  const oldFile = path.join(dir, fileNameForDate('test', old))
  const freshFile = path.join(dir, fileNameForDate('test', fresh))
  fs.writeFileSync(oldFile, 'stale\n')
  fs.writeFileSync(freshFile, 'recent\n')

  const uninstall = installConsoleFileLogger({ logDir: dir, prefix: 'test', retentionDays: 30, passthrough: false })
  uninstall()

  assert.equal(fs.existsSync(oldFile), false, '超过保留期的日志应被清理')
  assert.equal(fs.existsSync(freshFile), true, '保留期内的日志不应被清理')
})

test('日志目录不可用时不阻塞业务，console 继续可用', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-logger-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const blocker = path.join(dir, 'occupied') // 用文件占位目录路径，mkdir 会失败
  fs.writeFileSync(blocker, 'not a dir')
  const uninstall = installConsoleFileLogger({ logDir: path.join(blocker, 'logs'), prefix: 'test', passthrough: false })
  t.after(() => uninstall())
  assert.doesNotThrow(() => console.log('业务不受影响'))
  assert.doesNotThrow(() => console.error('错误也不落盘但不崩'))
})

test('重复安装幂等，一次卸载即恢复原始 console', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-logger-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const first = installConsoleFileLogger({ logDir: dir, prefix: 'test', passthrough: false })
  const second = installConsoleFileLogger({ logDir: dir, prefix: 'other', passthrough: false })
  assert.equal(second, first, '二次安装应返回同一个卸载函数')

  first()
  const file = path.join(dir, todayFileName('test'))
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  console.log('卸载后不应再写文件')
  const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  assert.equal(after, before, '卸载后 console 不应再写入日志文件')
})
