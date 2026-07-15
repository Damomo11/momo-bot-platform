const $ = id => document.getElementById(id)
const state = {
  user: null,
  authMode: 'login',
  view: 'bots',
  templates: [],
  accounts: [],
  bots: [],
  editingBotId: '',
  editingScheduleBotId: '',
  contractLoaded: false,
  templateRows: [],
  templateId: '',
  fileRows: [],
  selectedEntry: null,
  activeFile: '',
  originalContent: '',
  dirty: false,
  collapsedDirs: new Set(),
  fileDialogMode: 'create'
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
const fmt = value => value ? new Date(String(value).replace(' ', 'T') + 'Z').toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-'
const formatMomoc = value => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 6 })
const balanceText = user => `${formatMomoc(user?.momoc)} momoc${Number(user?.reservedMomoc || 0) > 0 ? ` · 已预留 ${formatMomoc(user.reservedMomoc)}` : ''}`
const templatePrice = template => `${formatMomoc(template?.priceMomoc)} momoc / ${template?.billingMode === 'once' ? '次' : '1h'}`
const kindLabel = value => ({ bot_usage: '机器人运行', bot_minute: '机器人运行', bot_hourly: '机器人运行', bot_once: '按次执行', admin_adjust: '管理员调整' })[value] || value

async function request (path, options = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options })
  const data = await res.json()
  if (!res.ok || data.ok === false) throw new Error(data.error || '请求失败')
  return data
}

const post = (path, data) => request(path, { method: 'POST', body: JSON.stringify(data) })

function toast (message) {
  $('toast').textContent = message
  $('toast').classList.remove('hidden')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => $('toast').classList.add('hidden'), 2800)
}

function statusLabel (value) {
  return {
    stopped: '已停止',
    starting: '启动中',
    connecting: '启动项目中',
    auth_required: '等待 OAuth',
    authenticated: 'OAuth 已完成',
    logging_in: '服务器登录中',
    resource_pack: '处理服务器资源包',
    protocol_fallback: '切换协议版本',
    completed: '执行成功',
    online: '在线',
    stopping: '停止中'
  }[value] || value
}

async function loadMe () {
  const data = await request('/api/me')
  if (!data.loggedIn) {
    $('auth').classList.remove('hidden')
    $('app').classList.add('hidden')
    return
  }
  state.user = data.user
  $('auth').classList.add('hidden')
  $('app').classList.remove('hidden')
  $('identity').textContent = data.user.username + (data.user.role === 'admin' ? ' · 管理员' : '')
  $('heroName').textContent = data.user.username
  $('heroBalance').textContent = formatMomoc(data.user.momoc)
  $('balance').textContent = balanceText(data.user)
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', data.user.role !== 'admin'))
  await loadTemplates()
  await loadAccountsData()
  await loadView()
}

async function submitAuth () {
  try {
    const path = state.authMode === 'login' ? '/api/login' : '/api/register'
    await post(path, { username: $('authUser').value, password: $('authPassword').value })
    $('authError').textContent = ''
    await loadMe()
  } catch (error) {
    $('authError').textContent = error.message
  }
}

async function loadTemplates () {
  const data = await request('/api/templates')
  state.templates = data.rows
  $('botTemplate').innerHTML = data.rows.map(row => `<option value="${esc(row.id)}">${esc(row.name)} · ${esc(templatePrice(row))}</option>`).join('')
  renderCreateVariables()
}

async function loadAccountsData () {
  const data = await request('/api/accounts')
  state.accounts = data.rows
  const authorized = data.rows.filter(row => row.authState === 'authorized')
  $('botAccount').innerHTML = authorized.length
    ? authorized.map(row => `<option value="${esc(row.id)}">${esc(row.minecraftName || row.email)} · ${esc(row.email)}</option>`).join('')
    : '<option value="">请先添加并授权微软账号</option>'
}

function variableInputsHtml (definitions, values = {}) {
  return definitions.map(definition => {
    const hasValue = Object.prototype.hasOwnProperty.call(values || {}, definition.key)
    const value = hasValue ? values[definition.key] : definition.default
    const label = `${esc(definition.label)}${definition.required ? ' *' : ''}`
    if (definition.type === 'boolean') {
      return `<label class="variable-check"><input type="checkbox" data-variable-key="${esc(definition.key)}"${value ? ' checked' : ''}> ${label}</label>`
    }
    if (definition.type === 'select') {
      return `<label>${label}<select data-variable-key="${esc(definition.key)}">${definition.options.map(option => `<option value="${esc(option.value)}"${String(value ?? '') === option.value ? ' selected' : ''}>${esc(option.label)}</option>`).join('')}</select></label>`
    }
    const attributes = [
      `data-variable-key="${esc(definition.key)}"`,
      definition.placeholder ? `placeholder="${esc(definition.placeholder)}"` : '',
      definition.maxLength ? `maxlength="${definition.maxLength}"` : '',
      definition.type === 'number' && definition.min != null ? `min="${definition.min}"` : '',
      definition.type === 'number' && definition.max != null ? `max="${definition.max}"` : '',
      definition.type === 'number' && definition.step != null ? `step="${definition.step}"` : ''
    ].filter(Boolean).join(' ')
    if (definition.type === 'textarea') return `<label>${label}<textarea ${attributes}>${esc(value ?? '')}</textarea></label>`
    return `<label>${label}<input type="${definition.type === 'number' ? 'number' : 'text'}" value="${esc(value ?? '')}" ${attributes}></label>`
  }).join('')
}

function renderCreateVariables () {
  const template = state.templates.find(row => row.id === $('botTemplate').value)
  const definitions = template?.variables || []
  $('selectedTemplatePrice').textContent = template ? templatePrice(template) : ''
  $('botVariableBlock').classList.toggle('hidden', !definitions.length)
  $('botVariables').innerHTML = variableInputsHtml(definitions)
}

function collectVariableValues (container) {
  const values = {}
  container.querySelectorAll('[data-variable-key]').forEach(input => {
    values[input.dataset.variableKey] = input.type === 'checkbox' ? input.checked : input.value
  })
  return values
}

function accountStatusLabel (value) {
  return { pending: '未授权', authorizing: '检查授权', auth_required: '等待 OAuth', authorized: '已授权', error: '授权失败' }[value] || value
}

async function loadAccounts () {
  await loadAccountsData()
  $('accountSummary').textContent = `${state.accounts.length} 个账号 · ${state.accounts.filter(row => row.authState === 'authorized').length} 个已授权`
  $('accountsTable').innerHTML = state.accounts.length
    ? '<table><thead><tr><th>Microsoft 账号</th><th>Minecraft</th><th>状态</th><th>OAuth2</th><th>机器人</th><th>操作</th></tr></thead><tbody>' + state.accounts.map(account => {
        const oauth = account.oauth
          ? `<div class="oauth"><a href="${esc(account.oauth.verificationUri)}" target="_blank" rel="noreferrer">打开 Microsoft 登录</a><br><code>${esc(account.oauth.userCode)}</code></div>`
          : '-'
        return `<tr><td><strong>${esc(account.email)}</strong></td><td>${esc(account.minecraftName || '-')}</td><td><span class="status ${esc(account.authState)}">${esc(accountStatusLabel(account.authState))}</span><div class="muted">${esc(account.lastError || '')}</div></td><td>${oauth}</td><td>${account.botCount}</td><td><div class="actions"><button class="primary" data-account-auth="${esc(account.id)}">${account.authState === 'authorized' ? '重新授权' : '授权'}</button><button class="danger" data-account-delete="${esc(account.id)}">删除</button></div></td></tr>`
      }).join('') + '</tbody></table>'
    : '<div class="empty">还没有微软账号。</div>'
  document.querySelectorAll('[data-account-auth]').forEach(btn => {
    btn.onclick = async () => {
      try {
        const account = state.accounts.find(row => row.id === btn.dataset.accountAuth)
        await post('/api/accounts/auth', { id: btn.dataset.accountAuth, force: account?.authState === 'authorized' })
        await loadAccounts()
      } catch (error) { toast(error.message) }
    }
  })
  document.querySelectorAll('[data-account-delete]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('确认删除这个微软账号和 OAuth 缓存？')) return
      try { await post('/api/accounts/delete', { id: btn.dataset.accountDelete }); await loadAccounts() } catch (error) { toast(error.message) }
    }
  })
}

async function createAccount () {
  try {
    const data = await post('/api/accounts/create', { email: $('accountEmail').value })
    $('accountEmail').value = ''
    await post('/api/accounts/auth', { id: data.account.id })
    toast('账号已添加，请完成 Microsoft OAuth2')
    await loadAccounts()
  } catch (error) {
    toast(error.message)
  }
}

async function loadBots () {
  const data = await request('/api/bots' + (state.user?.role === 'admin' ? '?all=1' : ''))
  state.bots = data.rows
  $('botSummary').textContent = `${data.rows.length} 个机器人 · ${data.rows.filter(row => row.runtimeState === 'online').length} 个在线`
  $('botsTable').innerHTML = data.rows.length
    ? '<table><thead><tr><th>机器人</th><th>服务器</th><th>模板</th><th>状态</th><th>OAuth2</th><th>计费</th><th>操作</th></tr></thead><tbody>' + data.rows.map(bot => {
        const oauth = bot.oauth
          ? `<div class="oauth"><a href="${esc(bot.oauth.verificationUri)}" target="_blank" rel="noreferrer">打开 Microsoft 登录</a><br><code>${esc(bot.oauth.userCode)}</code></div>`
          : '<span class="muted">-</span>'
        const action = bot.desiredState === 'running'
          ? `<button data-stop="${esc(bot.id)}">停止</button>`
          : `<button class="primary" data-start="${esc(bot.id)}">启动</button>`
        const variables = bot.variableDefinitions?.length ? `<button data-bot-variables="${esc(bot.id)}">变量</button>` : ''
        const schedule = bot.billingMode === 'once' && bot.allowScheduling ? `<button data-bot-schedule="${esc(bot.id)}">计划</button>` : ''
        return `<tr><td><strong>${esc(bot.label)}</strong><div class="muted">${esc(bot.microsoftEmail)}</div><div class="muted">${esc(bot.accountMinecraftName || bot.minecraftName || '')}</div></td><td>${esc(bot.serverHost)}:${esc(bot.serverPort)}<div class="muted">${esc(bot.minecraftVersion || '自动识别')}</div></td><td>${esc(bot.templateName)}<div class="price-hint">${esc(templatePrice(bot))}</div>${bot.variableDefinitions?.length ? `<div class="muted">${bot.variableDefinitions.length} 个变量</div>` : ''}${bot.scheduleEnabled ? '<div class="positive">计划已启用</div>' : ''}</td><td><span class="status ${esc(bot.runtimeState)}">${esc(statusLabel(bot.runtimeState))}</span><div class="muted">${esc(bot.lastError || '')}</div></td><td>${oauth}</td><td>${bot.billingMode === 'once' ? '按次' : `${esc(bot.billedMinutes)} 分钟`}</td><td><div class="actions">${action}${variables}${schedule}<button class="danger" data-delete="${esc(bot.id)}">删除</button></div></td></tr>`
      }).join('') + '</tbody></table>'
    : '<div class="empty">还没有机器人。</div>'
  bindBotActions()
}

function bindBotActions () {
  document.querySelectorAll('[data-start]').forEach(btn => { btn.onclick = () => botAction('/api/bots/start', btn.dataset.start) })
  document.querySelectorAll('[data-stop]').forEach(btn => { btn.onclick = () => botAction('/api/bots/stop', btn.dataset.stop) })
  document.querySelectorAll('[data-delete]').forEach(btn => {
    btn.onclick = async () => {
      if (confirm('确认删除这个机器人？')) await botAction('/api/bots/delete', btn.dataset.delete)
    }
  })
  document.querySelectorAll('[data-bot-variables]').forEach(btn => {
    btn.onclick = () => openBotVariableDialog(btn.dataset.botVariables)
  })
  document.querySelectorAll('[data-bot-schedule]').forEach(btn => {
    btn.onclick = () => openScheduleDialog(btn.dataset.botSchedule)
  })
}

async function botAction (path, id) {
  try {
    await post(path, { id })
    await loadBots()
    await refreshBalance()
  } catch (error) {
    toast(error.message)
  }
}

async function createBot () {
  try {
    await post('/api/bots/create', {
      label: $('botLabel').value,
      accountId: $('botAccount').value,
      serverHost: $('botHost').value,
      serverPort: $('botPort').value,
      minecraftVersion: $('botVersion').value,
      templateId: $('botTemplate').value,
      templateVariables: collectVariableValues($('botVariables'))
    })
    toast('机器人已创建')
    $('botLabel').value = ''
    await loadBots()
  } catch (error) {
    toast(error.message)
  }
}

async function refreshBalance () {
  const data = await request('/api/me')
  if (!data.loggedIn) return
  state.user = data.user
  $('balance').textContent = balanceText(data.user)
  $('heroBalance').textContent = formatMomoc(data.user.momoc)
}

async function loadLedger () {
  const data = await request('/api/ledger')
  state.user = data.user
  $('balance').textContent = balanceText(data.user)
  $('heroBalance').textContent = formatMomoc(data.user.momoc)
  $('ledgerSummary').textContent = `${data.rows.length} 条记录`
  $('ledgerTable').innerHTML = data.rows.length
    ? '<table><thead><tr><th>时间</th><th>类型</th><th>内容</th><th>用量</th><th>变动</th><th>余额</th></tr></thead><tbody>' + data.rows.map(row => {
        const usage = row.kind === 'bot_usage' || row.kind === 'bot_minute' || row.kind === 'bot_hourly'
        const once = row.kind === 'bot_once'
        const period = usage && row.startedAt && row.startedAt !== row.createdAt ? `${fmt(row.startedAt)} 至 ${fmt(row.createdAt)}` : fmt(row.createdAt)
        const content = usage ? (row.botLabel || String(row.note).replace(/\s*运行\s*\d+\s*分钟.*$/, '')) : (row.note || '-')
        return `<tr><td>${period}</td><td>${esc(kindLabel(row.kind))}</td><td>${esc(content)}</td><td>${usage ? `${Number(row.minutes || row.units || 1)} 分钟` : (once ? '1 次' : '-')}</td><td class="${row.delta > 0 ? 'positive' : 'negative'}">${row.delta > 0 ? '+' : ''}${formatMomoc(row.delta)}</td><td>${formatMomoc(row.balanceAfter)}</td></tr>`
      }).join('') + '</tbody></table>'
    : '<div class="empty">暂无 momoc 记录。</div>'
}

async function loadUsers () {
  const data = await request('/api/admin/users')
  $('userSummary').textContent = `${data.rows.length} 个用户`
  $('usersTable').innerHTML = '<table><thead><tr><th>用户</th><th>角色</th><th>momoc</th><th>调整</th></tr></thead><tbody>' + data.rows.map(row => `<tr><td><strong>${esc(row.username)}</strong></td><td>${esc(row.role)}</td><td>${formatMomoc(row.momoc)}${Number(row.reservedMomoc || 0) > 0 ? `<div class="muted">已预留 ${formatMomoc(row.reservedMomoc)}</div>` : ''}</td><td><div class="actions"><input style="width:120px" type="number" step="any" data-amount="${esc(row.id)}" placeholder="正负数量"><button class="primary" data-adjust="${esc(row.id)}">确认</button></div></td></tr>`).join('') + '</tbody></table>'
  document.querySelectorAll('[data-adjust]').forEach(btn => {
    btn.onclick = async () => {
      try {
        const input = document.querySelector(`[data-amount="${CSS.escape(btn.dataset.adjust)}"]`)
        await post('/api/admin/momoc', { userId: btn.dataset.adjust, amount: input.value })
        toast('momoc 已调整')
        await loadUsers()
        await refreshBalance()
      } catch (error) {
        toast(error.message)
      }
    }
  })
}

async function loadOverview () {
  const data = await request('/api/admin/overview')
  const stats = data.stats
  $('overviewStats').innerHTML = [
    ['用户', stats.users],
    ['微软账号', `${stats.authorizedAccounts} / ${stats.accounts} 已授权`],
    ['Bot', `${stats.runningBots} / ${stats.bots} 运行中`],
    ['累计消费', `${formatMomoc(stats.totalSpent)} momoc`]
  ].map(([label, value]) => `<div class="overview-stat"><span>${label}</span><strong>${value}</strong></div>`).join('')

  $('overviewAccounts').innerHTML = data.accounts.length
    ? '<table><thead><tr><th>用户</th><th>Microsoft 账号</th><th>Minecraft 名称</th><th>授权状态</th><th>Bot</th><th>使用模板</th></tr></thead><tbody>' + data.accounts.map(row => `<tr><td><strong>${esc(row.username)}</strong></td><td>${esc(row.email)}</td><td>${esc(row.minecraftName || '-')}</td><td><span class="status ${esc(row.authState)}">${esc(row.authState)}</span>${row.lastError ? `<div class="error">${esc(row.lastError)}</div>` : ''}</td><td>${row.botCount}</td><td>${row.templateNames.length ? row.templateNames.map(esc).join('、') : '-'}</td></tr>`).join('') + '</tbody></table>'
    : '<div class="empty">暂无微软账号授权。</div>'

  $('overviewBots').innerHTML = data.bots.length
    ? '<table><thead><tr><th>用户</th><th>Bot</th><th>微软账号</th><th>模板</th><th>计费</th><th>状态</th><th>定时</th><th>累计分钟</th></tr></thead><tbody>' + data.bots.map(row => `<tr><td><strong>${esc(row.ownerUsername)}</strong></td><td>${esc(row.label)}</td><td>${esc(row.accountMinecraftName || row.microsoftEmail)}</td><td>${esc(row.templateName)}</td><td>${esc(templatePrice(row))}</td><td><span class="status ${esc(row.runtimeState)}">${esc(row.runtimeState)}</span></td><td>${row.scheduleEnabled ? esc(row.scheduleCron || '已启用') : '-'}</td><td>${Number(row.billedMinutes || 0)}</td></tr>`).join('') + '</tbody></table>'
    : '<div class="empty">暂无 Bot。</div>'

  $('overviewConsumption').innerHTML = data.consumption.length
    ? '<table><thead><tr><th>用户</th><th>当前余额</th><th>预留</th><th>按小时消费</th><th>按次消费</th><th>总消费</th><th>Bot 分钟</th></tr></thead><tbody>' + data.consumption.map(row => `<tr><td><strong>${esc(row.username)}</strong><div class="muted">${esc(row.role)}</div></td><td>${formatMomoc(row.balance)}</td><td>${formatMomoc(row.reserved)}</td><td>${formatMomoc(row.hourlySpent)}</td><td>${formatMomoc(row.onceSpent)}</td><td><strong>${formatMomoc(row.totalSpent)}</strong></td><td>${row.billedMinutes}</td></tr>`).join('') + '</tbody></table>'
    : '<div class="empty">暂无用户消费数据。</div>'
}

async function loadTemplateAdmin (preferredId = state.templateId) {
  if (!state.contractLoaded) await loadTemplateContract()
  const data = await request('/api/admin/templates')
  state.templateRows = data.rows
  $('templateSummary').textContent = `${data.rows.length} 个模板`
  $('templateList').innerHTML = data.rows.length
    ? data.rows.map(row => `<button data-template="${esc(row.id)}"><strong>${esc(row.name)}</strong><span class="price-hint">${esc(templatePrice(row))}</span><span class="muted">${row.enabled ? '已启用' : '已停用'}</span></button>`).join('')
    : '<div class="empty">没有模板。</div>'
  document.querySelectorAll('[data-template]').forEach(btn => {
    btn.onclick = () => {
      if (!confirmDiscard()) return
      editTemplate(btn.dataset.template).catch(error => toast(error.message))
    }
  })
  const selected = data.rows.find(row => row.id === preferredId) || data.rows[0]
  if (selected) await editTemplate(selected.id)
  else clearTemplate()
}

async function loadTemplateContract () {
  try {
    const data = await request('/api/admin/template-contract')
    $('templateRequirementsText').textContent = data.contract
    state.contractLoaded = true
  } catch (error) {
    $('templateRequirementsText').textContent = `开发规范加载失败：${error.message}`
  }
}

async function copyTemplateRequirements () {
  const text = $('templateRequirementsText').textContent
  let copied = false
  try {
    await navigator.clipboard.writeText(text)
    copied = true
  } catch {}
  if (!copied) {
    const helper = document.createElement('textarea')
    helper.value = text
    helper.style.position = 'fixed'
    helper.style.opacity = '0'
    document.body.appendChild(helper)
    helper.select()
    copied = document.execCommand('copy')
    helper.remove()
  }
  toast(copied ? '开发规范已复制，可以直接发送给 AI' : '浏览器阻止了复制，请在规范文本中手动复制')
}

async function editTemplate (id) {
  const row = state.templateRows.find(item => item.id === id)
  if (!row) return
  state.templateId = row.id
  $('templateId').value = row.id
  $('templateName').value = row.name
  $('templateDescription').value = row.description
  $('templateBillingMode').value = row.billingMode
  $('templatePriceMomoc').value = row.priceMomoc
  $('templateAllowScheduling').checked = Boolean(row.allowScheduling)
  $('templateEnabled').checked = row.enabled
  $('templateZip').value = ''
  $('templateProjectPath').textContent = row.projectPath || ''
  document.querySelectorAll('[data-template]').forEach(btn => btn.classList.toggle('active', btn.dataset.template === id))
  $('fileManager').classList.remove('disabled')
  updateTemplatePriceLabel()
  state.collapsedDirs.clear()
  resetEditor()
  await loadTemplateFiles()
}

function clearTemplate () {
  if (!confirmDiscard()) return false
  state.templateId = ''
  state.fileRows = []
  state.selectedEntry = null
  $('templateId').value = ''
  $('templateName').value = ''
  $('templateDescription').value = ''
  $('templateBillingMode').value = 'hourly'
  $('templatePriceMomoc').value = '60'
  $('templateAllowScheduling').checked = false
  $('templateZip').value = ''
  $('templateProjectPath').textContent = '等待项目 ZIP'
  $('templateEnabled').checked = true
  updateTemplatePriceLabel()
  $('templateFiles').innerHTML = '<div class="empty">保存模板后显示项目文件。</div>'
  $('fileCount').textContent = '0 个'
  $('fileManager').classList.add('disabled')
  document.querySelectorAll('[data-template]').forEach(btn => btn.classList.remove('active'))
  resetEditor()
  return true
}

function fileBase64 (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function saveTemplate () {
  try {
    const file = $('templateZip').files?.[0]
    const zipBase64 = file ? await fileBase64(file) : ''
    const data = await post('/api/admin/templates/save', {
      id: $('templateId').value || undefined,
      name: $('templateName').value,
      description: $('templateDescription').value,
      billingMode: $('templateBillingMode').value,
      priceMomoc: $('templatePriceMomoc').value,
      allowScheduling: $('templateAllowScheduling').checked,
      zipBase64,
      enabled: $('templateEnabled').checked
    })
    toast('模板已保存')
    await loadTemplateAdmin(data.template.id)
    await loadTemplates()
  } catch (error) {
    toast(error.message)
  }
}

function updateTemplatePriceLabel () {
  const once = $('templateBillingMode').value === 'once'
  $('templatePriceLabel').textContent = once ? '每次价格' : '每小时价格'
  $('templateSchedulingLabel').classList.toggle('hidden', !once)
  if (!once) $('templateAllowScheduling').checked = false
}

async function deleteTemplate () {
  const id = state.templateId
  if (!id || !confirm('确认删除这个模板及其项目文件？')) return
  try {
    await post('/api/admin/templates/delete', { id })
    state.templateId = ''
    state.dirty = false
    await loadTemplateAdmin('')
    await loadTemplates()
    toast('模板已删除')
  } catch (error) {
    toast(error.message)
  }
}

async function loadTemplateFiles (preferredPath = '') {
  if (!state.templateId) return
  const query = new URLSearchParams({ id: state.templateId })
  const data = await request(`/api/admin/template-files?${query}`)
  state.fileRows = data.rows
  $('fileCount').textContent = `${data.rows.length} 个`
  const selectedPath = preferredPath || state.selectedEntry?.path || ''
  state.selectedEntry = data.rows.find(row => row.path === selectedPath) || null
  renderFileTree()
}

function renderFileTree () {
  const hiddenByParent = row => {
    const parts = row.path.split('/')
    parts.pop()
    let parent = ''
    for (const part of parts) {
      parent = parent ? `${parent}/${part}` : part
      if (state.collapsedDirs.has(parent)) return true
    }
    return false
  }
  const visible = state.fileRows.filter(row => !hiddenByParent(row))
  $('templateFiles').innerHTML = visible.length
    ? visible.map(row => {
        const active = state.selectedEntry?.path === row.path ? ' active' : ''
        const kind = row.type === 'directory' ? ' directory' : ''
        const icon = row.type === 'directory' ? (state.collapsedDirs.has(row.path) ? '▸' : '▾') : '·'
        return `<button class="file-entry${kind}${active}" data-file-path="${esc(row.path)}" style="padding-left:${10 + row.depth * 14}px"><span class="file-icon">${icon}</span><span class="file-name">${esc(row.name)}</span></button>`
      }).join('')
    : '<div class="empty">项目目录为空。</div>'
  document.querySelectorAll('[data-file-path]').forEach(btn => {
    btn.onclick = () => selectEntry(btn.dataset.filePath).catch(error => toast(error.message))
  })
}

async function selectEntry (filePath) {
  const row = state.fileRows.find(item => item.path === filePath)
  if (!row) return
  if (row.type === 'directory') {
    state.selectedEntry = row
    if (state.collapsedDirs.has(row.path)) state.collapsedDirs.delete(row.path)
    else state.collapsedDirs.add(row.path)
    renderFileTree()
    return
  }
  if (!confirmDiscard()) return
  const query = new URLSearchParams({ id: state.templateId, path: row.path })
  const data = await request(`/api/admin/template-files?${query}`)
  state.selectedEntry = row
  state.activeFile = row.path
  state.originalContent = data.file.content
  state.dirty = false
  $('activeFilePath').textContent = row.path
  $('fileContent').value = data.file.content
  $('fileContent').disabled = false
  $('saveFile').disabled = true
  $('dirtyMark').classList.add('hidden')
  renderFileTree()
}

function resetEditor (label = '选择文件') {
  state.activeFile = ''
  state.originalContent = ''
  state.dirty = false
  $('activeFilePath').textContent = label
  $('fileContent').value = ''
  $('fileContent').disabled = true
  $('saveFile').disabled = true
  $('dirtyMark').classList.add('hidden')
}

function confirmDiscard () {
  return !state.dirty || confirm('当前文件有未保存的修改，确认放弃？')
}

async function saveActiveFile () {
  if (!state.templateId || !state.activeFile) return
  try {
    await post('/api/admin/template-files/save', { id: state.templateId, path: state.activeFile, content: $('fileContent').value })
    state.originalContent = $('fileContent').value
    state.dirty = false
    $('saveFile').disabled = true
    $('dirtyMark').classList.add('hidden')
    await loadTemplateFiles(state.activeFile)
    toast('文件已保存，下次启动机器人时生效')
  } catch (error) {
    toast(error.message)
  }
}

function defaultParentPath () {
  const row = state.selectedEntry
  if (!row) return ''
  if (row.type === 'directory') return row.path + '/'
  const parts = row.path.split('/')
  parts.pop()
  return parts.length ? parts.join('/') + '/' : ''
}

function openFileDialog (mode, kind = 'file') {
  if (!state.templateId) return
  state.fileDialogMode = mode
  $('fileDialogError').textContent = ''
  $('fileDialog').classList.remove('hidden')
  if (mode === 'rename') {
    if (!state.selectedEntry) { closeFileDialog(); return toast('请先选择文件或目录') }
    $('fileDialogTitle').textContent = '重命名'
    $('fileKindLabel').classList.add('hidden')
    $('fileDialogPath').value = state.selectedEntry.path
  } else {
    $('fileDialogTitle').textContent = kind === 'directory' ? '新建目录' : '新建文件'
    $('fileKindLabel').classList.add('hidden')
    $('fileDialogKind').value = kind
    $('fileDialogPath').value = defaultParentPath()
  }
  requestAnimationFrame(() => {
    $('fileDialogPath').focus()
    $('fileDialogPath').setSelectionRange($('fileDialogPath').value.length, $('fileDialogPath').value.length)
  })
}

function closeFileDialog () {
  $('fileDialog').classList.add('hidden')
}

async function confirmFileDialog () {
  const nextPath = $('fileDialogPath').value.trim()
  if (!nextPath) {
    $('fileDialogError').textContent = '路径不能为空。'
    return
  }
  try {
    let selected = nextPath
    if (state.fileDialogMode === 'rename') {
      const previousPath = state.selectedEntry.path
      await post('/api/admin/template-files/rename', { id: state.templateId, path: previousPath, nextPath })
      if (state.activeFile === previousPath || state.activeFile.startsWith(previousPath + '/')) resetEditor()
    } else {
      await post('/api/admin/template-files/create', { id: state.templateId, path: nextPath, kind: $('fileDialogKind').value })
    }
    closeFileDialog()
    await loadTemplateFiles(selected)
    const row = state.fileRows.find(item => item.path === selected)
    if (row?.type === 'file') await selectEntry(selected)
    toast(state.fileDialogMode === 'rename' ? '已重命名' : '已创建')
  } catch (error) {
    $('fileDialogError').textContent = error.message
  }
}

async function deleteSelectedFile () {
  const row = state.selectedEntry
  if (!row) return toast('请先选择文件或目录')
  if (!confirm(`确认删除 ${row.path}？`)) return
  try {
    await post('/api/admin/template-files/delete', { id: state.templateId, path: row.path })
    if (state.activeFile === row.path || state.activeFile.startsWith(row.path + '/')) resetEditor()
    state.selectedEntry = null
    await loadTemplateFiles()
    toast('已删除')
  } catch (error) {
    toast(error.message)
  }
}

async function installDependencies () {
  if (!state.templateId) return
  const button = $('installDeps')
  button.disabled = true
  button.textContent = '安装中...'
  try {
    await post('/api/admin/template-files/install', { id: state.templateId })
    toast('依赖安装完成')
  } catch (error) {
    toast(error.message)
  } finally {
    button.disabled = false
    button.textContent = '安装依赖'
  }
}

function openBotVariableDialog (id) {
  const bot = state.bots.find(row => row.id === id)
  if (!bot) return
  state.editingBotId = id
  $('botVariableTitle').textContent = `${bot.label} · 模板变量`
  $('editBotVariables').innerHTML = variableInputsHtml(bot.variableDefinitions || [], bot.templateVariables || {})
  $('botVariableError').textContent = ''
  $('botVariableDialog').classList.remove('hidden')
}

function closeBotVariableDialog () {
  state.editingBotId = ''
  $('botVariableDialog').classList.add('hidden')
}

async function saveBotVariables () {
  if (!state.editingBotId) return
  try {
    await post('/api/bots/variables', {
      id: state.editingBotId,
      templateVariables: collectVariableValues($('editBotVariables'))
    })
    closeBotVariableDialog()
    await loadBots()
    toast('变量已保存，下次启动机器人时生效')
  } catch (error) {
    $('botVariableError').textContent = error.message
  }
}

function schedulePresetFromCron (expression) {
  if (expression === '*/5 * * * *') return { preset: 'every5', time: '08:00' }
  if (expression === '*/15 * * * *') return { preset: 'every15', time: '08:00' }
  if (expression === '0 * * * *') return { preset: 'hourly', time: '08:00' }
  if (expression === '0 */6 * * *') return { preset: 'every6hours', time: '08:00' }
  const daily = String(expression || '').match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/)
  return { preset: 'daily', time: daily ? `${String(daily[2]).padStart(2, '0')}:${String(daily[1]).padStart(2, '0')}` : '08:00' }
}

function scheduleCron () {
  const preset = $('schedulePreset').value
  if (preset === 'every5') return '*/5 * * * *'
  if (preset === 'every15') return '*/15 * * * *'
  if (preset === 'hourly') return '0 * * * *'
  if (preset === 'every6hours') return '0 */6 * * *'
  const [hour, minute] = $('scheduleTime').value.split(':').map(Number)
  return `${minute} ${hour} * * *`
}

function updateScheduleTimeVisibility () {
  $('scheduleTimeLabel').classList.toggle('hidden', $('schedulePreset').value !== 'daily')
}

function openScheduleDialog (id) {
  const bot = state.bots.find(row => row.id === id)
  if (!bot) return
  state.editingScheduleBotId = id
  const parsed = schedulePresetFromCron(bot.scheduleCron)
  $('scheduleTitle').textContent = `${bot.label} · 定时运行`
  $('scheduleEnabled').checked = bot.scheduleEnabled
  $('schedulePreset').value = parsed.preset
  $('scheduleTime').value = parsed.time
  $('scheduleError').textContent = ''
  updateScheduleTimeVisibility()
  $('scheduleDialog').classList.remove('hidden')
}

function closeScheduleDialog () {
  state.editingScheduleBotId = ''
  $('scheduleDialog').classList.add('hidden')
}

async function saveSchedule () {
  if (!state.editingScheduleBotId) return
  try {
    await post('/api/bots/schedule', { id: state.editingScheduleBotId, enabled: $('scheduleEnabled').checked, cron: scheduleCron() })
    closeScheduleDialog()
    await loadBots()
    toast('定时计划已保存')
  } catch (error) {
    $('scheduleError').textContent = error.message
  }
}

async function loadView () {
  document.querySelectorAll('.view').forEach(el => el.classList.add('hidden'))
  $(state.view + 'View').classList.remove('hidden')
  document.querySelectorAll('nav [data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === state.view))
  if (state.view === 'bots') await loadBots()
  if (state.view === 'accounts') await loadAccounts()
  if (state.view === 'ledger') await loadLedger()
  if (state.view === 'overview') await loadOverview()
  if (state.view === 'users') await loadUsers()
  if (state.view === 'templates') await loadTemplateAdmin()
}

document.querySelectorAll('[data-auth]').forEach(btn => {
  btn.onclick = () => {
    state.authMode = btn.dataset.auth
    document.querySelectorAll('[data-auth]').forEach(item => item.classList.toggle('active', item === btn))
    $('authSubmit').textContent = state.authMode === 'login' ? '登录' : '注册'
  }
})
$('authSubmit').onclick = submitAuth
$('authPassword').onkeydown = event => { if (event.key === 'Enter') submitAuth() }
$('logout').onclick = async () => { await post('/api/logout', {}); location.reload() }
document.querySelectorAll('nav [data-view]').forEach(btn => {
  btn.onclick = () => {
    if (state.view === 'templates' && !confirmDiscard()) return
    state.view = btn.dataset.view
    loadView().catch(error => toast(error.message))
  }
})
$('createBot').onclick = createBot
$('createAccount').onclick = createAccount
$('refreshAccounts').onclick = loadAccounts
$('botTemplate').onchange = renderCreateVariables
$('refreshBots').onclick = loadBots
$('refreshLedger').onclick = loadLedger
$('refreshOverview').onclick = loadOverview
$('refreshUsers').onclick = loadUsers
$('refreshTemplates').onclick = () => { if (confirmDiscard()) loadTemplateAdmin().catch(error => toast(error.message)) }
$('newTemplate').onclick = clearTemplate
$('saveTemplate').onclick = saveTemplate
$('deleteTemplate').onclick = deleteTemplate
$('templateBillingMode').onchange = updateTemplatePriceLabel
$('saveFile').onclick = saveActiveFile
$('newFile').onclick = () => openFileDialog('create', 'file')
$('newFolder').onclick = () => openFileDialog('create', 'directory')
$('renameFile').onclick = () => openFileDialog('rename')
$('deleteFile').onclick = deleteSelectedFile
$('installDeps').onclick = installDependencies
$('toggleTemplateRequirements').onclick = () => $('templateRequirements').classList.remove('hidden')
$('closeTemplateRequirements').onclick = () => $('templateRequirements').classList.add('hidden')
$('copyTemplateRequirements').onclick = copyTemplateRequirements
$('closeFileDialog').onclick = closeFileDialog
$('cancelFileDialog').onclick = closeFileDialog
$('confirmFileDialog').onclick = confirmFileDialog
$('fileDialogPath').onkeydown = event => { if (event.key === 'Enter') confirmFileDialog() }
$('fileDialog').onclick = event => { if (event.target === $('fileDialog')) closeFileDialog() }
$('closeBotVariableDialog').onclick = closeBotVariableDialog
$('cancelBotVariableDialog').onclick = closeBotVariableDialog
$('saveBotVariables').onclick = saveBotVariables
$('botVariableDialog').onclick = event => { if (event.target === $('botVariableDialog')) closeBotVariableDialog() }
$('closeScheduleDialog').onclick = closeScheduleDialog
$('cancelScheduleDialog').onclick = closeScheduleDialog
$('saveSchedule').onclick = saveSchedule
$('schedulePreset').onchange = updateScheduleTimeVisibility
$('scheduleDialog').onclick = event => { if (event.target === $('scheduleDialog')) closeScheduleDialog() }
$('fileContent').addEventListener('input', () => {
  state.dirty = $('fileContent').value !== state.originalContent
  $('saveFile').disabled = !state.dirty
  $('dirtyMark').classList.toggle('hidden', !state.dirty)
})
$('fileContent').addEventListener('keydown', event => {
  if (event.key === 'Tab') {
    event.preventDefault()
    const input = $('fileContent')
    const start = input.selectionStart
    input.setRangeText('  ', start, input.selectionEnd, 'end')
    input.dispatchEvent(new Event('input'))
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    saveActiveFile()
  }
})
window.addEventListener('beforeunload', event => {
  if (!state.dirty) return
  event.preventDefault()
  event.returnValue = ''
})

loadMe().catch(error => toast(error.message))
setInterval(() => {
  if (!state.user) return
  if (state.view === 'bots') Promise.all([loadBots(), refreshBalance()]).catch(() => {})
  if (state.view === 'accounts') loadAccounts().catch(() => {})
  if (state.view === 'ledger') loadLedger().catch(() => {})
  if (state.view === 'overview') loadOverview().catch(() => {})
}, 3000)
