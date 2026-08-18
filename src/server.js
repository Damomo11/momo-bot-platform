const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const AdmZip = require('adm-zip')
const { loadConfig } = require('./config')
const PlatformDb = require('./db')
const BotSupervisorClient = require('./botSupervisorClient')
const AccountManager = require('./accountManager')
const { normalizeDefinitions, readDefinitions, validateValues } = require('./templateVariables')
const { verifyCloudStoreToken } = require('./cloudStoreSso')
const { LoginAttemptLimiter, clientIp } = require('./security')
const { readRuntimeUpdates } = require('./runtimeUpdates')

const config = loadConfig()
const db = new PlatformDb(config)
const bots = new BotSupervisorClient(db, config)
const accounts = new AccountManager(db, config)
const publicRoot = path.join(config.root, 'public')
const templatesRoot = path.join(config.root, 'templates')
const hiddenProjectEntries = new Set(['node_modules', '.git'])
const maxEditableFileBytes = 1024 * 1024
const usedCloudStoreNonces = new Map()
const loginLimiter = new LoginAttemptLimiter({
  maxFailures: config.maxLoginFailures,
  windowMs: config.loginFailWindowMs,
  blockMs: config.loginBlockMs
})

function sessionCookie (token, sameSite = 'Strict') {
  return `bp_sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${config.sessionDays * 86400}${config.secureCookies ? '; Secure' : ''}`
}

function expiredSessionCookie (sameSite = 'Strict') {
  return `bp_sid=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0${config.secureCookies ? '; Secure' : ''}`
}

function cloudStoreSsoSecret () {
  try { return fs.readFileSync(config.cloudStoreSsoSecretFile, 'utf8').trim() } catch { return '' }
}

function templateProject (id) {
  const template = db.listTemplates(true).find(row => row.id === String(id || ''))
  if (!template) throw new Error('模板不存在。')
  const root = path.resolve(template.projectPath || '')
  const allowedRoot = path.resolve(templatesRoot) + path.sep
  if (!root.startsWith(allowedRoot) || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('模板项目目录不可用。')
  }
  return { template, root }
}

function normalizeProjectPath (input, allowEmpty = false) {
  const value = String(input || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!value && allowEmpty) return ''
  const parts = value.split('/')
  if (!value || parts.some(part => !part || part === '.' || part === '..' || hiddenProjectEntries.has(part))) {
    throw new Error('项目路径无效。')
  }
  return parts.join('/')
}

function projectTarget (root, input, allowEmpty = false) {
  const relative = normalizeProjectPath(input, allowEmpty)
  const target = relative ? path.resolve(root, ...relative.split('/')) : root
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('项目路径越界。')

  let cursor = root
  for (const part of relative ? relative.split('/') : []) {
    cursor = path.join(cursor, part)
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('不允许通过软链接访问项目文件。')
  }
  return { relative, target }
}

function listProjectFiles (root) {
  const rows = []
  function visit (directory, prefix = '', depth = 0) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => !hiddenProjectEntries.has(entry.name) && !entry.isSymbolicLink())
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'))
    for (const entry of entries) {
      if (rows.length >= 3000) throw new Error('模板文件数量超过 3000 个，无法在网页中管理。')
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(directory, entry.name)
      const stats = fs.statSync(absolute)
      rows.push({ path: relative, name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', size: entry.isFile() ? stats.size : 0, depth })
      if (entry.isDirectory()) visit(absolute, relative, depth + 1)
    }
  }
  visit(root)
  return rows
}

function readProjectFile (root, input) {
  const { relative, target } = projectTarget(root, input)
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('项目文件不存在。')
  const stats = fs.statSync(target)
  if (stats.size > maxEditableFileBytes) throw new Error('文件超过 1 MB，不能在网页中编辑。')
  const content = fs.readFileSync(target)
  if (content.includes(0)) throw new Error('二进制文件不能在网页中编辑。')
  return { path: relative, content: content.toString('utf8'), size: stats.size }
}

const platformCodeRoots = ['smart-runtime', 'signin-runtime']
const platformCodeFiles = new Set()

function platformCodeRows () {
  const rows = []
  for (const rootName of platformCodeRoots) {
    const root = path.join(config.root, rootName)
    if (!fs.existsSync(root)) continue
    rows.push({ path: rootName, name: rootName, type: 'directory', size: 0, depth: 0 })
    rows.push(...listProjectFiles(root).map(row => ({ ...row, path: `${rootName}/${row.path}`, depth: row.depth + 1 })))
  }
  for (const name of platformCodeFiles) {
    const file = path.join(config.root, name)
    if (fs.existsSync(file)) rows.push({ path: name, name, type: 'file', size: fs.statSync(file).size, depth: 0 })
  }
  return rows
}

function platformCodeTarget (input) {
  const relative = normalizeProjectPath(input)
  const allowed = platformCodeFiles.has(relative) || platformCodeRoots.some(root => relative.startsWith(`${root}/`))
  if (!allowed) throw new Error('这个平台文件不允许在网页中编辑。')
  return projectTarget(config.root, relative)
}

function templateDefinitions (template, strict = false) {
  try {
    return { variables: readDefinitions(template.projectPath), variableError: '' }
  } catch (error) {
    if (strict) throw new Error(`模板变量声明无效：${error.message}`)
    return { variables: [], variableError: error.message }
  }
}

function publicTemplate (template, admin = false) {
  const { projectPath, ...safe } = template
  return { ...safe, ...(admin ? { projectPath } : {}), ...templateDefinitions(template) }
}

function validatedTemplateValues (templateId, values) {
  const template = db.listTemplates(true).find(row => row.id === String(templateId || ''))
  if (!template || !template.enabled) throw new Error('机器人模板不可用。')
  return validateValues(templateDefinitions(template, true).variables, values)
}

function validatedModuleSelections (selections) {
  const available = db.listFeatureModules()
  return (Array.isArray(selections) ? selections : []).map(selection => {
    const feature = available.find(row => row.id === String(selection.moduleId || ''))
    if (!feature) throw new Error('功能模块不可用。')
    const definitions = normalizeDefinitions(feature.variables || [])
    return { moduleId: feature.id, variables: validateValues(definitions, selection.variables || {}) }
  })
}

function cookies (header = '') {
  return Object.fromEntries(String(header).split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2))
}

function json (res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

function error (res, err, req = null, url = null) {
  if (req && url && url.pathname.startsWith('/api/')) logPlatformAudit(req, url, err)
  else console.error(err)
  json(res, err.status || 400, { ok: false, error: err.message || String(err) })
}

const auditActions = new Map([
  ['POST /api/register', '注册账号'], ['POST /api/login', '登录'], ['POST /api/logout', '退出登录'], ['POST /api/password', '修改密码'],
  ['POST /api/accounts/create', '添加微软账号'], ['POST /api/accounts/auth', '授权微软账号'], ['POST /api/accounts/delete', '删除微软账号'],
  ['POST /api/smart/permissions', '修改智能 Bot 权限'], ['POST /api/smart/messages', '修改自定义消息'], ['POST /api/smart/tasks', '修改自定义任务'],
  ['POST /api/smart/automation', '停止智能 Bot 定时项'], ['POST /api/smart/prefixes', '修改命令前缀'], ['POST /api/bots/create', '创建 Bot'],
  ['POST /api/bots/schedule', '修改 Bot 计划'], ['POST /api/bots/start', '启动 Bot'], ['POST /api/bots/stop', '停止 Bot'],
  ['POST /api/bots/restart', '重启 Bot'], ['POST /api/bots/delete', '删除 Bot'], ['POST /api/admin/roles', '修改平台管理员'],
  ['POST /api/admin/momoc', '调整 momoc'], ['POST /api/admin/password', '重置用户密码'], ['POST /api/admin/modules/save', '保存功能模块'],
  ['POST /api/admin/modules/delete', '删除功能模块'], ['POST /api/admin/settings', '修改平台设置'], ['POST /api/admin/platform-files/save', '保存平台代码']
])

function auditActor (req) {
  if (req.platformAuditActor) return req.platformAuditActor
  const user = currentUser(req)
  if (user?.username) return user.username
  const input = req.platformAuditInput || {}
  if (req.url?.startsWith('/api/login') || req.url?.startsWith('/api/register')) return String(input.username || '未登录')
  return '未登录'
}

function auditTarget (req, url) {
  const input = req.platformAuditInput || {}
  const parts = []
  const add = (label, value) => {
    const text = String(value ?? '').trim().replace(/[\r\n\t]+/g, ' ').slice(0, 80)
    if (text) parts.push(`${label}=${text}`)
  }
  const isBotAction = url.pathname.startsWith('/api/bots/') || url.pathname.startsWith('/api/smart/')
  const botId = isBotAction ? input.botId || input.id || url.searchParams.get('botId') : ''
  if (botId) {
    const bot = db.getBot(botId)
    add('Bot', bot ? `${bot.label}(${String(botId).slice(0, 8)})` : botId)
  } else if (url.pathname === '/api/bots/create') add('Bot', input.label)
  if (url.pathname === '/api/smart/tasks') add('任务', input.name || input.originalName)
  if (url.pathname === '/api/smart/permissions') add('玩家', input.playerName)
  if (url.pathname.startsWith('/api/accounts/')) add('账号', input.email || input.id)
  if (url.pathname === '/api/admin/roles') add('用户', input.username || input.userId)
  if (url.pathname === '/api/admin/momoc' || url.pathname === '/api/admin/password') add('用户', input.userId)
  if (url.pathname.includes('/modules')) add('模块', input.name || input.id)
  if (url.pathname === '/api/admin/platform-files/save') add('文件', input.path)
  if (input.action) add('动作', input.action)
  return parts.join(' ') || '-'
}

function logPlatformAudit (req, url, err = null) {
  const action = auditActions.get(`${req.method} ${url.pathname}`)
  if (!action || req.platformAuditLogged) return
  req.platformAuditLogged = true
  const reason = err ? ` 原因=${String(err.message || err).replace(/[\r\n\t]+/g, ' ').slice(0, 240)}` : ''
  console.log(`[平台] 玩家=${auditActor(req)} 操作=${action} 目标=${auditTarget(req, url)} 结果=${err ? '失败' : '成功'}${reason}`)
  if (err && (Number(err.status || 400) >= 500 || err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError)) console.error(err)
}

async function body (req, maxBytes = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('请求内容过大。')
    chunks.push(chunk)
  }
  if (!chunks.length) return (req.platformAuditInput = {})
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  req.platformAuditInput = input && typeof input === 'object' ? input : {}
  return input
}

function installTemplateProject (input) {
  const id = String(input.id || crypto.randomUUID())
  const existing = db.listTemplates(true).find(row => row.id === id)
  let projectPath = existing?.projectPath || ''
  if (input.zipBase64) {
    const templatesRoot = path.join(config.root, 'templates')
    const tempPath = path.join(templatesRoot, `.upload-${id}`)
    const finalPath = path.join(templatesRoot, id)
    fs.rmSync(tempPath, { recursive: true, force: true })
    fs.mkdirSync(tempPath, { recursive: true })
    const zip = new AdmZip(Buffer.from(String(input.zipBase64), 'base64'))
    for (const entry of zip.getEntries()) {
      const destination = path.resolve(tempPath, entry.entryName)
      if (!destination.startsWith(path.resolve(tempPath) + path.sep)) throw new Error('ZIP 包含非法路径。')
    }
    zip.extractAllTo(tempPath, true)
    let sourceRoot = tempPath
    if (!fs.existsSync(path.join(sourceRoot, 'package.json'))) {
      const directories = fs.readdirSync(tempPath, { withFileTypes: true }).filter(entry => entry.isDirectory())
      if (directories.length === 1 && fs.existsSync(path.join(tempPath, directories[0].name, 'package.json'))) sourceRoot = path.join(tempPath, directories[0].name)
    }
    if (!fs.existsSync(path.join(sourceRoot, 'package.json'))) throw new Error('完整项目 ZIP 根目录必须包含 package.json。')
    const packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'))
    normalizeDefinitions(packageJson.botPlatform?.variables)
    const entry = String(packageJson.botPlatform?.entry || packageJson.main || 'index.js')
    if (!fs.existsSync(path.resolve(sourceRoot, entry))) throw new Error(`package.json 指定的入口不存在：${entry}`)
    fs.rmSync(finalPath, { recursive: true, force: true })
    fs.cpSync(sourceRoot, finalPath, { recursive: true })
    fs.rmSync(tempPath, { recursive: true, force: true })
    const install = spawnSync('npm', ['install', '--omit=dev'], { cwd: finalPath, shell: true, encoding: 'utf8', timeout: 300000 })
    if (install.status !== 0) {
      fs.rmSync(finalPath, { recursive: true, force: true })
      throw new Error(`项目依赖安装失败：${install.stderr || install.stdout}`)
    }
    projectPath = finalPath
  }
  if (!projectPath) throw new Error('新模板必须上传完整项目 ZIP。')
  return db.saveTemplate({ id, name: input.name, description: input.description, projectPath, billingMode: input.billingMode, priceMomoc: input.priceMomoc, allowScheduling: input.allowScheduling, enabled: input.enabled !== false })
}

function currentUser (req) {
  return db.getSessionUser(cookies(req.headers.cookie).bp_sid)
}

function requireUser (req) {
  const user = currentUser(req)
  if (!user) { const err = new Error('请先登录。'); err.status = 401; throw err }
  req.platformAuditActor = user.username
  return user
}

function requireAdmin (req) {
  const user = requireUser(req)
  if (user.role !== 'admin') { const err = new Error('需要管理员权限。'); err.status = 403; throw err }
  return user
}

function botForUser (id, user) {
  const bot = db.getBot(id)
  if (!bot || (user.role !== 'admin' && bot.userId !== user.id)) { const err = new Error('找不到机器人。'); err.status = 404; throw err }
  return bot
}

function appendRelatedBotLog (botId, message, level = 'schedule') {
  if (typeof db.appendBotLog !== 'function') return
  db.appendBotLog(botId, 'related', level, String(message || '').replace(/[\r\n\t]+/g, ' ').slice(0, 2000))
}

async function api (req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'bot-self-hosting-platform' })
  if (req.method === 'GET' && url.pathname === '/api/public-settings') {
    return json(res, 200, { ok: true, registrationEnabled: db.getRegistrationEnabled(), ...db.getRuntimeSettings(), platformName: 'Bot 自托管平台' })
  }
  if (req.method === 'GET' && url.pathname === '/api/runtime-updates') {
    requireUser(req)
    return json(res, 200, { ok: true, smart: readRuntimeUpdates(config.root, 'smart') })
  }
  if (req.method === 'GET' && url.pathname === '/api/me') {
    const user = currentUser(req)
    return json(res, 200, { ok: true, loggedIn: Boolean(user), user })
  }
  if (req.method === 'POST' && url.pathname === '/api/register') {
    if (!db.getRegistrationEnabled()) { const err = new Error('本地注册已关闭，请从云仓库进入。'); err.status = 403; throw err }
    const input = await body(req)
    const user = db.createUser(input.username, input.password)
    const session = db.createSession(user.id)
    return json(res, 200, { ok: true, user }, { 'set-cookie': sessionCookie(session.token) })
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const ip = clientIp(req, config.trustProxy)
    loginLimiter.assertAllowed(ip)
    const input = await body(req)
    const user = db.authenticate(input.username, input.password)
    if (!user) {
      const record = loginLimiter.recordFailure(ip)
      if (record.blockedUntil) console.warn(`[security] blocked login attempts from ${ip}`)
      const err = new Error('用户名或密码错误。'); err.status = 401; throw err
    }
    loginLimiter.clear(ip)
    const session = db.createSession(user.id)
    return json(res, 200, { ok: true, user }, { 'set-cookie': sessionCookie(session.token) })
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    req.platformAuditActor = currentUser(req)?.username || '未登录'
    db.deleteSession(cookies(req.headers.cookie).bp_sid)
    return json(res, 200, { ok: true }, { 'set-cookie': expiredSessionCookie() })
  }
  if (req.method === 'POST' && url.pathname === '/api/password') {
    const user = requireUser(req)
    const input = await body(req)
    if (String(input.newPassword || '') !== String(input.confirmPassword || '')) throw new Error('两次输入的新密码不一致。')
    db.changeUserPassword(user.id, input.currentPassword, input.newPassword)
    return json(res, 200, { ok: true }, { 'set-cookie': expiredSessionCookie() })
  }
  if (req.method === 'GET' && url.pathname === '/api/modes') {
    requireUser(req)
    return json(res, 200, { ok: true, prices: db.getModePrices() })
  }
  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    const user = requireUser(req)
    return json(res, 200, { ok: true, rows: accounts.list(user.role === 'admin' && url.searchParams.get('all') === '1' ? null : user.id) })
  }
  if (req.method === 'POST' && url.pathname === '/api/accounts/create') {
    const user = requireUser(req)
    const input = await body(req)
    return json(res, 200, { ok: true, account: accounts.create(user.id, input.email) })
  }
  if (req.method === 'POST' && ['/api/accounts/auth', '/api/accounts/delete'].includes(url.pathname)) {
    const user = requireUser(req)
    const input = await body(req)
    const actor = user.role === 'admin' ? null : user.id
    if (url.pathname.endsWith('/auth')) accounts.authorize(input.id, actor, Boolean(input.force), { refreshCode: Boolean(input.refreshCode) })
    if (url.pathname.endsWith('/delete')) accounts.remove(input.id, actor)
    return json(res, 200, { ok: true })
  }
  if (req.method === 'GET' && url.pathname === '/api/bots') {
    const user = requireUser(req)
    const rows = await bots.list(user.role === 'admin' && url.searchParams.get('all') === '1' ? null : user.id)
    return json(res, 200, { ok: true, rows })
  }
  if (req.method === 'GET' && url.pathname === '/api/bots/logs') {
    const user = requireUser(req)
    const bot = botForUser(url.searchParams.get('botId'), user)
    const kind = String(url.searchParams.get('kind') || 'general')
    if (!['general', 'related'].includes(kind)) throw new Error('日志类型无效。')
    return json(res, 200, { ok: true, bot: { id: bot.id, label: bot.label }, kind, rows: db.listBotLogs(bot.id, kind) })
  }
  if (req.method === 'GET' && url.pathname === '/api/smart/permissions') {
    const user = requireUser(req)
    const bot = botForUser(url.searchParams.get('botId'), user)
    if (bot.mode !== 'smart') throw new Error('只有智能 Bot 使用游戏内权限。')
    return json(res, 200, {
      ok: true,
      bot: { id: bot.id, label: bot.label, ownerUsername: bot.ownerUsername },
      rows: db.listSmartPermissions(bot.userId),
      lock: db.getSmartBotLock(bot.id),
      settings: db.getSmartBotSettings(bot.id)
    })
  }
  if (req.method === 'POST' && url.pathname === '/api/smart/permissions') {
    const user = requireUser(req)
    const input = await body(req)
    const bot = botForUser(input.botId, user)
    if (bot.mode !== 'smart') throw new Error('只有智能 Bot 使用游戏内权限。')
    if (input.action === 'settings') {
      const settings = db.setSmartBotSettings(bot.id, { commandPrefix: input.commandPrefix })
      await bots.syncSmartSettings(bot.id)
      return json(res, 200, { ok: true, settings })
    }
    const role = String(input.role || '')
    let result
    if (input.action === 'remove') {
      result = db.removeSmartPermission(bot.userId, input.playerName, role)
    } else {
      const minutes = Number(input.minutes || 0)
      if (minutes && (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600 || role === 'admin')) throw new Error('临时时长必须为 1-525600 分钟，且超管只能永久添加。')
      result = db.setSmartPermission(bot.userId, input.playerName, role, {
        expiresAt: minutes ? Date.now() + minutes * 60000 : null,
        createdBy: `web:${user.username}`
      })
    }
    return json(res, 200, { ok: true, result, rows: db.listSmartPermissions(bot.userId) })
  }
  if (req.method === 'GET' && url.pathname === '/api/smart/messages') {
    const user = requireUser(req)
    return json(res, 200, { ok: true, overrides: db.getSmartUserMessages(user.id) })
  }
  if (req.method === 'POST' && url.pathname === '/api/smart/messages') {
    const user = requireUser(req)
    const input = await body(req)
    const current = db.getSmartUserMessages(user.id)
    const resetKeys = Array.isArray(input.resetKeys) ? input.resetKeys.map(String) : []
    for (const key of resetKeys) delete current[key]
    const overrides = db.setSmartUserMessages(user.id, input.reset ? {} : resetKeys.length ? current : input.overrides)
    await Promise.all(db.listBots(user.id).filter(row => row.mode === 'smart').map(row => bots.syncSmartSettings(row.id)))
    return json(res, 200, { ok: true, overrides })
  }
  if (req.method === 'GET' && url.pathname === '/api/smart/tasks') {
    const user = requireUser(req)
    const bot = botForUser(url.searchParams.get('botId'), user)
    if (bot.userId !== user.id) { const err = new Error('自定义任务只能查看自己的机器人。'); err.status = 403; throw err }
    return json(res, 200, { ok: true, rows: db.listSmartBotTasks(bot.id), bots: (await bots.list(user.id)).filter(row => row.mode === 'smart') })
  }
  if (req.method === 'POST' && url.pathname === '/api/smart/tasks') {
    const user = requireUser(req)
    const input = await body(req)
    const bot = botForUser(input.botId, user)
    if (bot.userId !== user.id) { const err = new Error('自定义任务只能修改自己的机器人。'); err.status = 403; throw err }
    const previous = db.getSmartBotTask(bot.id, input.originalName || input.name)
    let result
    if (input.action === 'delete') result = db.deleteSmartBotTask(bot.id, input.name)
    else if (input.action === 'schedule') result = db.scheduleSmartBotTask(bot.id, input.name, input.intervalTicks === '' ? null : input.intervalTicks)
    else result = db.setSmartBotTask(bot.id, input)
    if (input.action === 'schedule') {
      const enabled = input.intervalTicks !== '' && input.intervalTicks != null
      appendRelatedBotLog(bot.id, `网页用户 ${user.username} ${enabled ? '开启' : '关闭'}了定时任务「${result.name}」。`)
    } else if (previous?.intervalTicks != null) {
      appendRelatedBotLog(bot.id, `网页用户 ${user.username} ${input.action === 'delete' ? '删除任务并关闭' : '编辑任务时关闭'}了定时任务「${previous.name}」。`)
    }
    await bots.syncSmartSettings(bot.id)
    return json(res, 200, { ok: true, result, rows: db.listSmartBotTasks(bot.id) })
  }
  if (req.method === 'POST' && url.pathname === '/api/smart/automation') {
    const user = requireUser(req)
    const input = await body(req)
    const bot = botForUser(input.botId, user)
    if (bot.mode !== 'smart') throw new Error('只有智能 Bot 使用游戏内定时任务。')
    const action = String(input.action || '')
    if (action === 'stop_ominous') db.setSmartBotOminousBottle(bot.id, false)
    else if (action === 'stop_fishing') db.setSmartBotFishing(bot.id, false)
    else if (action === 'stop_periodic_right_click') db.setSmartBotPeriodicRightClick(bot.id, { enabled: false })
    else if (action === 'stop_task') db.scheduleSmartBotTask(bot.id, input.name, null)
    else throw new Error('未知的定时任务操作。')
    const scheduleName = {
      stop_ominous: '定时灾厄之瓶',
      stop_fishing: '自动钓鱼',
      stop_periodic_right_click: '定时放置',
      stop_task: String(input.name || '')
    }[action]
    appendRelatedBotLog(bot.id, `网页用户 ${user.username} 关闭了定时任务「${scheduleName}」。`)
    const schedules = await bots.syncSmartAutomation(bot.id)
    return json(res, 200, { ok: true, schedules })
  }
  if (req.method === 'GET' && url.pathname === '/api/smart/prefixes') {
    const user = requireUser(req)
    return json(res, 200, { ok: true, rows: db.listSmartBotPrefixes(user.id) })
  }
  if (req.method === 'POST' && url.pathname === '/api/smart/prefixes') {
    const user = requireUser(req)
    const input = await body(req)
    const bot = botForUser(input.botId, user)
    if (bot.userId !== user.id || bot.mode !== 'smart') throw new Error('只能修改自己的智能 Bot 前缀。')
    const settings = db.setSmartBotSettings(bot.id, { commandPrefix: input.commandPrefix })
    await bots.syncSmartSettings(bot.id)
    return json(res, 200, { ok: true, settings })
  }
  if (req.method === 'POST' && url.pathname === '/api/bots/create') {
    const user = requireUser(req)
    const input = await body(req)
    if (typeof db.getRuntimeSettings === 'function' && !db.getRuntimeSettings().botCreationEnabled) {
      const err = new Error('平台暂时停止创建新 Bot。')
      err.status = 403
      throw err
    }
    const account = db.getMicrosoftAccount(input.accountId)
    if (!account || account.userId !== user.id) throw new Error('请选择自己的微软账号。')
    if (account.authState !== 'authorized') throw new Error('微软账号还没有完成 OAuth2 授权。')
    const bot = db.createBot(user.id, input)
    return json(res, 200, { ok: true, bot: bots.publicBot(bot) })
  }
  if (req.method === 'POST' && url.pathname === '/api/bots/schedule') {
    const user = requireUser(req)
    const input = await body(req)
    botForUser(input.id, user)
    const updated = await bots.setSchedule(input.id, Boolean(input.enabled), String(input.cron || ''), user.role === 'admin' ? null : user.id)
    appendRelatedBotLog(input.id, `网页用户 ${user.username} ${input.enabled ? '开启' : '关闭'}了 Bot 运行计划${input.enabled ? `（${String(input.cron || '')}）` : ''}。`)
    return json(res, 200, { ok: true, bot: updated })
  }
  if (req.method === 'POST' && ['/api/bots/start', '/api/bots/stop', '/api/bots/restart', '/api/bots/delete'].includes(url.pathname)) {
    const user = requireUser(req)
    const input = await body(req)
    botForUser(input.id, user)
    if (url.pathname.endsWith('/start')) await bots.start(input.id, user.role === 'admin' ? null : user.id)
    if (url.pathname.endsWith('/stop')) await bots.stop(input.id, user.role === 'admin' ? null : user.id)
    if (url.pathname.endsWith('/restart')) await bots.restart(input.id, user.role === 'admin' ? null : user.id)
    if (url.pathname.endsWith('/delete')) await bots.remove(input.id, user.role === 'admin' ? null : user.id)
    return json(res, 200, { ok: true })
  }
  if (req.method === 'GET' && url.pathname === '/api/ledger') {
    const user = requireUser(req)
    return json(res, 200, { ok: true, rows: db.listLedger(user.id), user: db.getUser(user.id) })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/users') {
    requireAdmin(req)
    return json(res, 200, { ok: true, rows: db.listUsers() })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/roles') {
    requireAdmin(req)
    return json(res, 200, { ok: true, rows: db.listPlatformAdmins(), rootUsername: config.cloudStoreAdminUsername })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/roles') {
    const admin = requireAdmin(req)
    const input = await body(req)
    const result = input.action === 'remove'
      ? db.removePlatformAdmin(input.userId, { actorUserId: admin.id, rootUsername: config.cloudStoreAdminUsername })
      : db.addPlatformAdmin(input.username)
    return json(res, 200, { ok: true, user: result, rows: db.listPlatformAdmins() })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
    requireAdmin(req)
    const overview = db.adminOverview()
    const runtimeById = new Map((await bots.list()).map(bot => [bot.id, bot]))
    overview.bots = overview.bots.map(bot => {
      const runtime = runtimeById.get(bot.id)
      return runtime
        ? { ...bot, runtimeVersion: runtime.runtimeVersion, latestRuntimeVersion: runtime.latestRuntimeVersion, updateAvailable: runtime.updateAvailable, smartSchedules: runtime.smartSchedules }
        : bot
    })
    return json(res, 200, { ok: true, ...overview })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/momoc') {
    const admin = requireAdmin(req)
    const input = await body(req)
    const balance = db.adjustMomoc(input.userId, Number(input.amount), 'admin_adjust', `admin=${admin.username}; ${String(input.note || '')}`)
    return json(res, 200, { ok: true, balance })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/password') {
    const admin = requireAdmin(req)
    const input = await body(req)
    db.setUserPassword(input.userId, input.password)
    const selfReset = input.userId === admin.id
    return json(res, 200, { ok: true, selfReset })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/modules') {
    requireAdmin(req)
    return json(res, 200, { ok: true, rows: db.listFeatureModules(true) })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/modules/save') {
    requireAdmin(req)
    const input = await body(req)
    const feature = db.saveFeatureModule(input)
    await Promise.all(db.listBots().filter(bot => db.listBotModules(bot.id).some(row => row.id === feature.id)).map(bot => bots.syncModules(bot.id)))
    return json(res, 200, { ok: true, module: feature })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/settings') {
    requireAdmin(req)
    return json(res, 200, { ok: true, ...db.getModePrices(), ...db.getRuntimeSettings(), ...db.getSmartTopUpSettings(), registrationEnabled: db.getRegistrationEnabled(), newUserInitialMomoc: db.getNewUserInitialMomoc() })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/settings') {
    requireAdmin(req)
    const input = await body(req)
    const prices = db.setModePrices(input)
    if (Object.prototype.hasOwnProperty.call(input, 'registrationEnabled')) db.setRegistrationEnabled(Boolean(input.registrationEnabled))
    if (Object.prototype.hasOwnProperty.call(input, 'newUserInitialMomoc')) db.setNewUserInitialMomoc(input.newUserInitialMomoc)
    const topUp = db.setSmartTopUpSettings({ recipient: input.recipient, commandTemplate: input.commandTemplate })
    await bots.syncSmartTopUpSettings()
    const runtime = db.setRuntimeSettings(input)
    return json(res, 200, { ok: true, ...prices, ...runtime, ...topUp, registrationEnabled: db.getRegistrationEnabled(), newUserInitialMomoc: db.getNewUserInitialMomoc() })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/modules/delete') {
    requireAdmin(req)
    const input = await body(req)
    db.deleteFeatureModule(input.id)
    return json(res, 200, { ok: true })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/platform-files') {
    requireAdmin(req)
    const file = url.searchParams.get('path')
    if (file !== null) {
      const entry = platformCodeTarget(file)
      return json(res, 200, { ok: true, file: readProjectFile(config.root, entry.relative) })
    }
    return json(res, 200, { ok: true, rows: platformCodeRows() })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/platform-files/save') {
    requireAdmin(req)
    const input = await body(req, maxEditableFileBytes + 64 * 1024)
    const entry = platformCodeTarget(input.path)
    const content = String(input.content ?? '')
    if (Buffer.byteLength(content, 'utf8') > maxEditableFileBytes) throw new Error('文件超过 1 MB。')
    const temp = `${entry.target}.tmp-${process.pid}-${Date.now()}`
    try {
      fs.writeFileSync(temp, content, 'utf8')
      fs.renameSync(temp, entry.target)
    } finally {
      if (fs.existsSync(temp)) fs.rmSync(temp, { force: true })
    }
    return json(res, 200, { ok: true, effective: 'next_start', runningBotsUnaffected: true })
  }
  const err = new Error('Not found')
  err.status = 404
  throw err
}

function cloudStoreLogin (res, url) {
  const identity = verifyCloudStoreToken(url.searchParams.get('token'), cloudStoreSsoSecret())
  const now = Date.now()
  for (const [nonce, expiresAt] of usedCloudStoreNonces) if (expiresAt <= now) usedCloudStoreNonces.delete(nonce)
  if (usedCloudStoreNonces.has(identity.nonce)) { const err = new Error('云仓库登录凭证已经使用。'); err.status = 401; throw err }
  usedCloudStoreNonces.set(identity.nonce, identity.expiresAt)
  const user = db.upsertCloudStoreUser(identity.externalId, identity.username, config.cloudStoreAdminUsername)
  const session = db.createSession(user.id)
  res.writeHead(302, {
    location: '/',
    'cache-control': 'no-store',
    'set-cookie': sessionCookie(session.token, 'Lax')
  })
  res.end()
}

function staticFile (res, pathname) {
  const names = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' }
  const name = names[pathname]
  if (!name) return false
  const file = path.join(publicRoot, name)
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
  res.writeHead(200, { 'content-type': types[path.extname(file)], 'cache-control': 'no-cache' })
  fs.createReadStream(file).pipe(res)
  return true
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  const url = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'GET' && url.pathname === '/auth/cloud-store') return cloudStoreLogin(res, url)
    if (url.pathname.startsWith('/api/')) {
      await api(req, res, url)
      logPlatformAudit(req, url)
      return
    }
    if (!staticFile(res, url.pathname)) { res.writeHead(404); res.end('Not found') }
  } catch (err) { error(res, err, req, url) }
})

async function startServer () {
  await bots.ensureStarted()
  server.listen(config.port, config.host, () => {
    console.log(`Bot 自托管平台: http://${config.host}:${config.port}/`)
    console.log(`Bot 守护进程: 127.0.0.1:${config.supervisorPort}`)
    const prices = db.getModePrices()
    console.log(`Billing: smart ${prices.smartHourlyPrice} momoc/1h; signin ${prices.signinOncePrice} momoc/success`)
  })
}

startServer().catch(error => {
  console.error(error)
  db.close()
  process.exit(1)
})

function shutdownPlatform () {
  server.close(() => { db.close(); process.exit(0) })
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', shutdownPlatform)
process.on('SIGTERM', shutdownPlatform)
