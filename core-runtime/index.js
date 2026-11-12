const fs = require('node:fs')
const http = require('node:http')
const { loadConfig } = require('../src/config')
const PlatformDb = require('../src/db')
const BotManager = require('../src/botManager')
const { SupervisorHotReloader } = require('../src/supervisorHotReload')

const SUPERVISOR_API_VERSION = 3

const config = loadConfig()
// 守护进程自身的 console 落盘（logs/runtime-日期.log），与平台管理服务、
// bot 进程（platformPreload 挂载，logs/bot-日期.log）分文件，互不混流。
// shouldIgnore 与 platformPreload 同源：bot 进程已在其源头丢弃协议噪音，
// 这里同条滤掉是双保险（8789 转发的 bot stdout 以外仍可能有同类残留）。
if (process.env.BOT_PLATFORM_FILE_LOG !== 'off') {
  const path = require('node:path')
  // 与 platformPreload 同源：含 PartialReadError（protocol 1.21.11 粒子包
  // 读越界的刷屏残留，bot 侧已在入口丢弃，这里是转 stdout 的双保险）。
  const PROTOCOL_NOISE = /partial packet|Chunk size is \d+ but only \d+ was read|PartialReadError: Read error for undefined/
  require('../src/logger').installConsoleFileLogger({ logDir: path.join(config.root, 'logs'), prefix: 'runtime', shouldIgnore: text => PROTOCOL_NOISE.test(text) })
}

// 兜底：2026-11-05 事故复盘（INC-2026-1105-01）——守护进程是全部 Bot 生命周期的
// 单点，此前任何漏出的异步异常（botManager 对刚退出子进程 send 触发的 EPIPE、
// IPC 通道关闭的 error 事件等）都会让整个进程退出，16 个 bot 全部陪葬。
// 落盘后不退出：记录现场，继续值守。真正的致命错误（内存耗尽等）由系统层处理。
process.on('uncaughtException', error => {
  console.error('[bot-supervisor] uncaught exception (process stays alive):', error?.stack || error?.message || error)
})
process.on('unhandledRejection', reason => {
  console.error('[bot-supervisor] unhandled rejection (process stays alive):', reason?.stack || reason?.message || reason)
})

const token = String(process.env.BOT_PLATFORM_SUPERVISOR_TOKEN || (() => {
  try { return fs.readFileSync(config.supervisorSecretFile, 'utf8').trim() } catch { return '' }
})())

if (token.length < 32) throw new Error('Bot 守护进程密钥不存在或无效。')

const db = new PlatformDb(config)
const bots = new BotManager(db, config)
const hotReloader = new SupervisorHotReloader({ root: config.root, config, db, bots })
hotReloader.start()

function json (res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function body (req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('请求内容过大。')
    chunks.push(chunk)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

async function command (input) {
  const actor = input.actorUserId == null ? null : String(input.actorUserId)
  if (input.action === 'list') return bots.list(input.userId == null ? null : String(input.userId))
  if (input.action === 'start') return bots.start(String(input.id), actor)
  if (input.action === 'stop') return bots.stop(String(input.id), actor)
  if (input.action === 'restart') return bots.restart(String(input.id), actor)
  if (input.action === 'remove') return bots.remove(String(input.id), actor)
  if (input.action === 'set_schedule') return bots.setSchedule(String(input.id), Boolean(input.enabled), String(input.expression || ''), actor)
  if (input.action === 'sync_smart_settings') return bots.syncSmartSettings(String(input.id))
  if (input.action === 'sync_smart_automation') return bots.syncSmartAutomation(String(input.id))
  if (input.action === 'sync_modules') return bots.syncModules(String(input.id))
  if (input.action === 'baltop_status') return bots.baltopStatus()
  throw new Error('未知的 Bot 守护进程操作。')
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { ok: false, error: '未授权。' })
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, service: 'bot-supervisor', apiVersion: SUPERVISOR_API_VERSION, runtimeRevision: hotReloader.revision, pid: process.pid })
    if (req.method === 'POST' && req.url === '/shutdown') {
      json(res, 200, { ok: true })
      setImmediate(shutdown)
      return
    }
    if (req.method === 'POST' && req.url === '/command') return json(res, 200, { ok: true, result: await command(await body(req)) })
    return json(res, 404, { ok: false, error: 'Not found' })
  } catch (error) {
    console.error(error)
    return json(res, error.status || 400, { ok: false, error: error.message || String(error) })
  }
})

server.on('error', error => {
  // 事故复盘 P3：此前直接 process.exit(1)，端口被占/socket 异常时自杀且无现场。
  // 现在先把详情落盘（console 已被包装为同步写 logs/runtime-日期.log）再退出。
  console.error('[bot-supervisor] HTTP server fatal error, exiting:', error?.stack || error?.message || error)
  try { shutdown() } catch (shutdownError) {
    console.error('[bot-supervisor] shutdown failed during server error:', shutdownError)
    process.exit(1)
  }
})

server.listen(config.supervisorPort, '127.0.0.1', () => {
  db.recoverBotRuntimeAfterSupervisorStart()
  bots.startDesiredBots()
  console.log(`[bot-supervisor] listening on 127.0.0.1:${config.supervisorPort}; pid=${process.pid}`)
})

function shutdown () {
  hotReloader.stop()
  bots.shutdown()
  server.close(() => {
    db.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
