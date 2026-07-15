const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const AdmZip = require('adm-zip')
const { loadConfig } = require('./config')
const PlatformDb = require('./db')
const BotManager = require('./botManager')
const AccountManager = require('./accountManager')
const { normalizeDefinitions, readDefinitions, validateValues } = require('./templateVariables')

const config = loadConfig()
const db = new PlatformDb(config)
const bots = new BotManager(db, config)
const accounts = new AccountManager(db, config)
const publicRoot = path.join(config.root, 'public')
const templatesRoot = path.join(config.root, 'templates')
const hiddenProjectEntries = new Set(['node_modules', '.git'])
const maxEditableFileBytes = 1024 * 1024

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

function cookies (header = '') {
  return Object.fromEntries(String(header).split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2))
}

function json (res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

function error (res, err) {
  console.error(err)
  json(res, err.status || 400, { ok: false, error: err.message || String(err) })
}

async function body (req, maxBytes = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('请求内容过大。')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
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

async function api (req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/me') {
    const user = currentUser(req)
    return json(res, 200, { ok: true, loggedIn: Boolean(user), user })
  }
  if (req.method === 'POST' && url.pathname === '/api/register') {
    const input = await body(req)
    const user = db.createUser(input.username, input.password)
    const session = db.createSession(user.id)
    return json(res, 200, { ok: true, user }, { 'set-cookie': `bp_sid=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionDays * 86400}` })
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const input = await body(req)
    const user = db.authenticate(input.username, input.password)
    if (!user) { const err = new Error('用户名或密码错误。'); err.status = 401; throw err }
    const session = db.createSession(user.id)
    return json(res, 200, { ok: true, user }, { 'set-cookie': `bp_sid=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionDays * 86400}` })
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    db.deleteSession(cookies(req.headers.cookie).bp_sid)
    return json(res, 200, { ok: true }, { 'set-cookie': 'bp_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' })
  }
  if (req.method === 'GET' && url.pathname === '/api/templates') {
    requireUser(req)
    return json(res, 200, { ok: true, rows: db.listTemplates(false).map(row => publicTemplate(row)) })
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
    if (url.pathname.endsWith('/auth')) accounts.authorize(input.id, actor, Boolean(input.force))
    if (url.pathname.endsWith('/delete')) accounts.remove(input.id, actor)
    return json(res, 200, { ok: true })
  }
  if (req.method === 'GET' && url.pathname === '/api/bots') {
    const user = requireUser(req)
    const rows = bots.list(user.role === 'admin' && url.searchParams.get('all') === '1' ? null : user.id).map(bot => {
      const template = db.listTemplates(true).find(row => row.id === bot.templateId)
      return { ...bot, variableDefinitions: template ? templateDefinitions(template).variables : [] }
    })
    return json(res, 200, { ok: true, rows })
  }
  if (req.method === 'POST' && url.pathname === '/api/bots/create') {
    const user = requireUser(req)
    const input = await body(req)
    const account = db.getMicrosoftAccount(input.accountId)
    if (!account || account.userId !== user.id) throw new Error('请选择自己的微软账号。')
    if (account.authState !== 'authorized') throw new Error('微软账号还没有完成 OAuth2 授权。')
    input.templateVariables = validatedTemplateValues(input.templateId, input.templateVariables)
    const bot = db.createBot(user.id, input)
    return json(res, 200, { ok: true, bot: bots.publicBot(bot) })
  }
  if (req.method === 'POST' && url.pathname === '/api/bots/variables') {
    const user = requireUser(req)
    const input = await body(req)
    const bot = botForUser(input.id, user)
    const values = validatedTemplateValues(bot.templateId, input.templateVariables)
    db.updateBotVariables(bot.id, values)
    return json(res, 200, { ok: true, bot: bots.publicBot(db.getBot(bot.id)) })
  }
  if (req.method === 'POST' && url.pathname === '/api/bots/schedule') {
    const user = requireUser(req)
    const input = await body(req)
    botForUser(input.id, user)
    const bot = bots.setSchedule(input.id, Boolean(input.enabled), String(input.cron || ''), user.role === 'admin' ? null : user.id)
    return json(res, 200, { ok: true, bot })
  }
  if (req.method === 'POST' && ['/api/bots/start', '/api/bots/stop', '/api/bots/delete'].includes(url.pathname)) {
    const user = requireUser(req)
    const input = await body(req)
    botForUser(input.id, user)
    if (url.pathname.endsWith('/start')) await bots.start(input.id, user.role === 'admin' ? null : user.id)
    if (url.pathname.endsWith('/stop')) await bots.stop(input.id, user.role === 'admin' ? null : user.id)
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
  if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
    requireAdmin(req)
    return json(res, 200, { ok: true, ...db.adminOverview() })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/momoc') {
    const admin = requireAdmin(req)
    const input = await body(req)
    const balance = db.adjustMomoc(input.userId, Number(input.amount), 'admin_adjust', `admin=${admin.username}; ${String(input.note || '')}`)
    return json(res, 200, { ok: true, balance })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/templates') {
    requireAdmin(req)
    return json(res, 200, { ok: true, rows: db.listTemplates(true).map(row => publicTemplate(row, true)) })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/template-contract') {
    requireAdmin(req)
    const contract = fs.readFileSync(path.join(config.root, 'TEMPLATE_CONTRACT.md'), 'utf8')
    return json(res, 200, { ok: true, contract })
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/template-files') {
    requireAdmin(req)
    const { root } = templateProject(url.searchParams.get('id'))
    const file = url.searchParams.get('path')
    if (file !== null) return json(res, 200, { ok: true, file: readProjectFile(root, file) })
    return json(res, 200, { ok: true, rows: listProjectFiles(root) })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/templates/save') {
    requireAdmin(req)
    const input = await body(req, 40 * 1024 * 1024)
    const template = installTemplateProject(input)
    for (const bot of db.listBots().filter(row => row.templateId === template.id)) bots.syncSchedule(bot.id)
    return json(res, 200, { ok: true, template })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/templates/delete') {
    requireAdmin(req)
    const input = await body(req)
    const template = db.listTemplates(true).find(row => row.id === input.id)
    const changed = db.deleteTemplate(input.id)
    if (changed && template?.projectPath && input.id !== 'idle-login') {
      const resolved = path.resolve(template.projectPath)
      const root = path.resolve(config.root, 'templates') + path.sep
      if (resolved.startsWith(root)) fs.rmSync(resolved, { recursive: true, force: true })
    }
    return json(res, 200, { ok: true, changed })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/template-files/save') {
    requireAdmin(req)
    const input = await body(req, maxEditableFileBytes + 64 * 1024)
    const { root } = templateProject(input.id)
    const { relative, target } = projectTarget(root, input.path)
    const content = String(input.content ?? '')
    if (Buffer.byteLength(content, 'utf8') > maxEditableFileBytes) throw new Error('文件超过 1 MB，不能保存。')
    if (relative === 'package.json') {
      const packageJson = JSON.parse(content)
      normalizeDefinitions(packageJson.botPlatform?.variables)
    }
    const parent = path.dirname(target)
    projectTarget(root, path.relative(root, parent).replace(/\\/g, '/'), true)
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error('文件所在目录不存在。')
    fs.writeFileSync(target, content, 'utf8')
    return json(res, 200, { ok: true, file: { path: relative, size: Buffer.byteLength(content, 'utf8') } })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/template-files/create') {
    requireAdmin(req)
    const input = await body(req)
    const { root } = templateProject(input.id)
    const { relative, target } = projectTarget(root, input.path)
    if (fs.existsSync(target)) throw new Error('同名文件或目录已经存在。')
    const parent = path.dirname(target)
    projectTarget(root, path.relative(root, parent).replace(/\\/g, '/'), true)
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error('上级目录不存在。')
    if (input.kind === 'directory') fs.mkdirSync(target)
    else fs.writeFileSync(target, '', { encoding: 'utf8', flag: 'wx' })
    return json(res, 200, { ok: true, entry: { path: relative, type: input.kind === 'directory' ? 'directory' : 'file' } })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/template-files/rename') {
    requireAdmin(req)
    const input = await body(req)
    const { root } = templateProject(input.id)
    const source = projectTarget(root, input.path)
    const destination = projectTarget(root, input.nextPath)
    if (source.relative === 'package.json') throw new Error('package.json 不能改名。')
    if (!fs.existsSync(source.target)) throw new Error('要重命名的文件不存在。')
    if (fs.existsSync(destination.target)) throw new Error('目标名称已经存在。')
    const parent = path.dirname(destination.target)
    projectTarget(root, path.relative(root, parent).replace(/\\/g, '/'), true)
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error('目标目录不存在。')
    fs.renameSync(source.target, destination.target)
    return json(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/template-files/delete') {
    requireAdmin(req)
    const input = await body(req)
    const { root } = templateProject(input.id)
    const entry = projectTarget(root, input.path)
    if (entry.relative === 'package.json') throw new Error('package.json 不能删除。')
    if (!fs.existsSync(entry.target)) throw new Error('要删除的文件不存在。')
    fs.rmSync(entry.target, { recursive: true, force: false })
    return json(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/template-files/install') {
    requireAdmin(req)
    const input = await body(req)
    const { root } = templateProject(input.id)
    const install = spawnSync('npm', ['install', '--omit=dev'], { cwd: root, shell: true, encoding: 'utf8', timeout: 300000 })
    if (install.status !== 0) throw new Error(`依赖安装失败：${install.stderr || install.stdout}`)
    return json(res, 200, { ok: true, output: String(install.stdout || '').slice(-4000) })
  }
  const err = new Error('Not found')
  err.status = 404
  throw err
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
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url)
    if (!staticFile(res, url.pathname)) { res.writeHead(404); res.end('Not found') }
  } catch (err) { error(res, err) }
})

server.listen(config.port, config.host, () => {
  console.log(`Momo Bot Platform: http://${config.host}:${config.port}/`)
  console.log('Billing: template-specific hourly or successful-run pricing')
  if (config.generatedAdminPassword) console.log(`Bootstrap admin: ${config.bootstrapAdminUsername} / ${config.bootstrapAdminPassword}`)
  bots.startDesiredBots()
})

process.on('SIGINT', () => {
  bots.shutdown()
  server.close(() => { db.close(); process.exit(0) })
  setTimeout(() => process.exit(0), 3000).unref()
})
