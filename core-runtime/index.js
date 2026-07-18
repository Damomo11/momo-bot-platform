const fs = require('node:fs')
const http = require('node:http')
const { loadConfig } = require('../src/config')
const PlatformDb = require('../src/db')
const BotManager = require('../src/botManager')

const SUPERVISOR_API_VERSION = 3

const config = loadConfig()
const token = String(process.env.BOT_PLATFORM_SUPERVISOR_TOKEN || (() => {
  try { return fs.readFileSync(config.supervisorSecretFile, 'utf8').trim() } catch { return '' }
})())

if (token.length < 32) throw new Error('Bot 守护进程密钥不存在或无效。')

const db = new PlatformDb(config)
const bots = new BotManager(db, config)

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
  if (input.action === 'remove') return bots.remove(String(input.id), actor)
  if (input.action === 'set_schedule') return bots.setSchedule(String(input.id), Boolean(input.enabled), String(input.expression || ''), actor)
  if (input.action === 'sync_smart_settings') return bots.syncSmartSettings(String(input.id))
  if (input.action === 'sync_smart_automation') return bots.syncSmartAutomation(String(input.id))
  if (input.action === 'sync_modules') return bots.syncModules(String(input.id))
  throw new Error('未知的 Bot 守护进程操作。')
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { ok: false, error: '未授权。' })
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, service: 'bot-supervisor', apiVersion: SUPERVISOR_API_VERSION, pid: process.pid })
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
  console.error('[bot-supervisor]', error)
  process.exit(1)
})

server.listen(config.supervisorPort, '127.0.0.1', () => {
  db.recoverBotRuntimeAfterSupervisorStart()
  bots.startDesiredBots()
  console.log(`[bot-supervisor] listening on 127.0.0.1:${config.supervisorPort}; pid=${process.pid}`)
})

function shutdown () {
  bots.shutdown()
  server.close(() => {
    db.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
