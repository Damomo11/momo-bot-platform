'use strict'

const fs = require('node:fs')
const path = require('node:path')
const util = require('node:util')

// Console 落盘：平台此前只有 screen 终端输出，回滚缓冲一丢或进程一重启就什么
// 都查不到。这里在进程内对 console.log/warn/error 做一层包装，同写
// logs/<prefix>-YYYY-MM-DD.log（按天滚动，启动时清理超过保留期的旧文件）；
// stdout 原样输出不变，screen 会话里的观感不受影响。
// 包装点写入失败只提醒一次并继续走 stdout，任何日志问题都不能阻塞业务。

const state = {
  installed: null,
  warned: false
}

const original = {
  log: console.log,
  warn: console.warn,
  error: console.error
}

function pad (value, width = 2) {
  return String(value).padStart(width, '0')
}

function localTimestamp (date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function fileNameFor (date, prefix) {
  return `${prefix}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.log`
}

function pruneOldFiles (logDir, prefix, retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000
  const pattern = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.log$`)
  for (const name of fs.readdirSync(logDir)) {
    const match = name.match(pattern)
    if (!match) continue
    const fileTime = Date.parse(`${match[1]}T00:00:00`) // 本地时区零点，与文件名口径一致
    if (Number.isFinite(fileTime) && fileTime < cutoff) {
      fs.rmSync(path.join(logDir, name), { force: true })
    }
  }
}

function warnOnce (message) {
  if (state.warned) return
  state.warned = true
  original.warn(`[file-log] 控制台日志文件写入失败（本进程不再重复提醒）：${message}`)
}

function formatEntry (level, args) {
  const stamp = localTimestamp(new Date())
  // 多行消息（堆栈、长 JSON）逐行都补时间戳：单行时间戳对不上时间线，
  // 复盘时没法按发生时刻 grep。
  return util.format(...args).split('\n').map(line => `${stamp} [${level}] ${line}`).join('\n') + '\n'
}

function installConsoleFileLogger (options = {}) {
  if (state.installed) return state.installed.uninstall

  const logDir = path.resolve(String(options.logDir || path.join(process.cwd(), 'logs')))
  const prefix = String(options.prefix || 'platform').replace(/[^a-z0-9-]/gi, '') || 'platform'
  const retentionDays = Math.max(1, Math.floor(Number(options.retentionDays) || 30))
  // 单文件大小上限（字节）：bot 的协议层在实体多的区域会每秒刷几百条
  // "Chunk size ... partial packet" 类调试残留，风暴场景下按天文件一天能烧
  // 7GB+（2026-11-06 实测，差点写满盘）。shouldIgnore 在入口丢弃已知噪音；
  // maxFileBytes 是最后兜底：文件写满上限后停止落盘并只提醒一次，宁可
  // 丢日志也不能烧盘。
  const shouldIgnore = typeof options.shouldIgnore === 'function' ? options.shouldIgnore : null
  const maxFileBytes = Math.max(64 * 1024, Math.floor(Number(options.maxFileBytes) || 512 * 1024 * 1024))
  const capped = new Set()
  try {
    fs.mkdirSync(logDir, { recursive: true })
    pruneOldFiles(logDir, prefix, retentionDays)
  } catch (error) {
    warnOnce(error?.message || String(error))
  }

  const passthrough = options.passthrough !== false
  const write = (level, args) => {
    const file = path.join(logDir, fileNameFor(new Date(), prefix))
    try {
      if (!capped.has(file)) {
        // 每天一个新文件名，capped 集合跨天自动"复位"（新文件不在集合里）。
        for (const cappedFile of capped) if (cappedFile !== file) capped.delete(cappedFile)
        if (fs.existsSync(file) && fs.statSync(file).size >= maxFileBytes) {
          capped.add(file)
          original.warn(`[file-log] ${path.basename(file)} 已达 ${Math.floor(maxFileBytes / 1024 / 1024)}MB 上限，本文件停止落盘（新一天自动恢复）；stdout 输出不受影响。`)
          return
        }
      } else {
        return
      }
      fs.appendFileSync(file, formatEntry(level, args))
    } catch (error) {
      warnOnce(error?.message || String(error))
    }
  }
  const wrap = (level, originalWrite) => (...args) => {
    // 已知噪音在包装层整条丢弃：既不落盘也不再打到 stdout（屏幕与文件观感一致）。
    if (shouldIgnore && shouldIgnore(util.format(...args))) return
    if (passthrough) originalWrite(...args)
    write(level, args)
  }

  console.log = wrap('info', original.log)
  console.warn = wrap('warn', original.warn)
  console.error = wrap('error', original.error)

  const uninstall = () => {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
    state.installed = null
  }
  state.installed = { uninstall }
  return uninstall
}

module.exports = { installConsoleFileLogger }
