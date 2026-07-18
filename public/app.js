const $ = id => document.getElementById(id)
const state = {
  user: null,
  authMode: 'login',
  view: 'bots',
  managementTab: 'overview',
  templates: [],
  modules: [],
  baseHourlyPrice: 0,
  botSettings: { commandPrefix: '!', whitelist: [] },
  accounts: [],
  bots: [],
  managedBots: [],
  editingBotId: '',
  editingScheduleBotId: '',
  editingPermissionBotId: '',
  editingTaskBotId: '',
  contractLoaded: false,
  templateRows: [],
  templateId: '',
  moduleId: '',
  moduleAdminRows: [],
  platformFilePath: '',
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
const commandUsage = command => `${state.botSettings?.commandPrefix || '!'}${String(command || '').replace(/^\s*[!@=]+/, '')}`
const kindLabel = value => ({ bot_usage: '机器人基础运行', bot_minute: '机器人基础运行', bot_hourly: '机器人基础运行', bot_once: '模板按次执行', module_hourly: '功能模块运行', module_once: '功能模块执行', admin_adjust: '管理员调整' })[value] || value
const TASK_COMMANDS = ['上车', '下车', '清空', '切换', '放置', '右键', '指令']
const MESSAGE_DEFAULTS = {
  permissionUsage: '正确格式: {command} 玩家名', permissionResult: '玩家 {player} {status}{label}中{remaining}',
  openBoxUsage: '正确格式: 开盒 玩家名', openBoxSuccess: '开盒成功！玩家 {player} 的坐标为 ({x},{z}) {dimension}', openBoxFailure: '开盒失败！未找到该玩家或地图服务暂时不可用。',
  nearUsage: '正确格式: near [玩家名]', nearSuccess: '{players}', nearEmpty: '附近没有可显示的玩家。', nearFailure: 'near 查询失败！未找到玩家 {player} 或地图服务暂时不可用。',
  mountAlready: '机器人已经在载具上。', mountMissing: '附近 6 格内没有可乘坐的矿车。', mountSuccess: '机器人已上车。', mountFailure: '上车失败，请确认矿车可乘坐且距离足够近。',
  dismountMissing: '机器人当前没有乘坐矿车。', dismountSuccess: '机器人已下车。', dismountFailure: '下车失败，请稍后重试。',
  clearEmpty: '机器人背包已经是空的。', clearSuccess: '背包已清空，共丢出 {stacks} 组、{items} 个物品。', clearFailure: '清空背包中断，已丢出 {stacks} 组。原因: {reason}',
  switchUsage: '正确格式: 切换 1-9', switchSuccess: '快捷栏已切换到第 {slot} 格。',
  ominousUsage: '正确格式: 定时灾厄之瓶 开|关', ominousEnabled: '定时灾厄之瓶已开启，将立即饮用一瓶；成功后每 31 分钟执行一次。', ominousDisabled: '定时灾厄之瓶已关闭。', ominousStatusOn: '定时灾厄之瓶: 开，下次执行: {nextTime}', ominousStatusOff: '定时灾厄之瓶: 关。',
  periodicRightClickUsage: '正确格式: 定时放置 x y z ngt，例如 定时放置 100 64 200 20。', periodicRightClickEnabled: '定时放置已开启: ({x},{y},{z})，每 {ticks} 游戏刻执行。', periodicRightClickDisabled: '定时放置已关闭。', periodicRightClickStatusOff: '定时放置: 关。', periodicRightClickStatusOn: '定时放置: 开，坐标 ({x},{y},{z})，间隔 {ticks} 游戏刻。',
  rightClickUsage: '正确格式: 右键 玩家名，或 右键 x y z。', rightClickSuccess: '右键交互成功。', rightClickFailure: '右键交互失败，请确认目标存在且在交互距离内。', placeUsage: '正确格式: 放置 x y z。', placeSuccess: '放置成功。', placeFailure: '{reason}',
  taskUsage: '正确格式: 定时任务 任务名 5；关闭时使用 定时任务 任务名 关。', taskScheduled: '定时任务 {task} 已开启，每 {ticks} 游戏刻执行一次。', taskStopped: '定时任务 {task} 已关闭。', scheduleStatus: '定时：{schedules}',
  locked: '机器人已被 {player} {label}，备注: {reason}', lockUsage: '正确格式: 锁定 备注', alreadyLocked: '机器人已被锁定，请勿重复锁定。', lockSuccess: '锁定成功，由于发消息会取消 afk，请寻找安全地方挂机。', notLocked: '机器人没有被锁定。', adminUnlockRequired: '机器人处于超级锁定，请由超管使用“超级解锁”。', unlockSuccess: '机器人已解锁。',
  forwardUsage: '正确格式: 指令 <服务器指令>', forwardInvalid: '指令内容无效或过长。', forwardNested: '不能嵌套机器人命令前缀。', forwardDangerous: '这条高风险指令已禁用。', forwardHome: 'home 命令已禁用。',
  restartLocked: '机器人锁定中，请先确认挂机状态并解锁。', restarting: '机器人正在重启。',
  permissionAdded: '玩家 {player} 已成功加入{label}', permissionExists: '玩家 {player} 已经在{label}中', permissionRemoved: '玩家 {player} 已从{label}移除', permissionMissing: '玩家 {player} 不在{label}中', temporaryUsage: '正确格式: {command} 玩家名 分钟数', temporaryAdded: '玩家 {player} 已临时加入{label}，持续 {minutes} 分钟',
  adminLockUsage: '正确格式: 超级锁定 备注', alreadyAdminLocked: '机器人已被超级锁定，请勿重复锁定。', adminLockSuccess: '超级锁定成功，禁用一切白名单命令，仅超管可使用“超级解锁”。', notAdminLocked: '机器人没有被超级锁定。', adminUnlockSuccess: '机器人已超级解锁，普通锁定也已同时解除。'
}
const MESSAGE_LABELS = Object.fromEntries(Object.keys(MESSAGE_DEFAULTS).map(key => [key, ({ permissionUsage: '权限查询格式', permissionResult: '权限查询结果', openBoxUsage: '开盒格式', openBoxSuccess: '开盒成功', openBoxFailure: '开盒失败', nearUsage: '附近查询格式', nearSuccess: '附近查询结果', nearEmpty: '附近无人', nearFailure: '附近查询失败', mountAlready: '已经在载具中', mountMissing: '未找到矿车', mountSuccess: '上车成功', mountFailure: '上车失败', dismountMissing: '当前未乘车', dismountSuccess: '下车成功', dismountFailure: '下车失败', clearEmpty: '背包已空', clearSuccess: '清空成功', clearFailure: '清空失败', switchUsage: '切换格式', switchSuccess: '切换成功', ominousUsage: '灾厄之瓶格式', ominousEnabled: '灾厄定时开启', ominousDisabled: '灾厄定时关闭', ominousStatusOn: '灾厄定时状态开启', ominousStatusOff: '灾厄定时状态关闭', periodicRightClickUsage: '定时放置格式', periodicRightClickEnabled: '定时放置开启', periodicRightClickDisabled: '定时放置关闭', periodicRightClickStatusOn: '定时放置状态开启', periodicRightClickStatusOff: '定时放置状态关闭', rightClickUsage: '右键格式', rightClickSuccess: '右键成功', rightClickFailure: '右键失败', placeUsage: '放置格式', placeSuccess: '放置成功', placeFailure: '放置失败', taskUsage: '定时任务格式', taskScheduled: '定时任务开启', taskStopped: '定时任务关闭', locked: '锁定状态', lockUsage: '锁定格式', alreadyLocked: '重复锁定', lockSuccess: '锁定成功', notLocked: '未锁定', adminUnlockRequired: '需要超级解锁', unlockSuccess: '解锁成功', forwardUsage: '指令格式', forwardInvalid: '指令无效', forwardNested: '嵌套指令', forwardDangerous: '高风险指令', forwardHome: 'Home 禁用', restartLocked: '锁定时重启', restarting: '正在重启', permissionAdded: '添加权限成功', permissionExists: '权限已存在', permissionRemoved: '移除权限成功', permissionMissing: '权限不存在', temporaryUsage: '临时权限格式', temporaryAdded: '临时权限成功', adminLockUsage: '超级锁定格式', alreadyAdminLocked: '重复超级锁定', adminLockSuccess: '超级锁定成功', notAdminLocked: '未超级锁定', adminUnlockSuccess: '超级解锁成功' })[key] || key]))

MESSAGE_LABELS.scheduleStatus = '定时状态'

const MESSAGE_GROUPS = [
  { command: '查白 / 查黑 / 查超管', note: '权限查询反馈', keys: ['permissionUsage', 'permissionResult'] },
  { command: '开盒', note: '玩家坐标查询反馈', keys: ['openBoxUsage', 'openBoxSuccess', 'openBoxFailure'] },
  { command: 'near', note: '附近玩家查询反馈', keys: ['nearUsage', 'nearSuccess', 'nearEmpty', 'nearFailure'] },
  { command: '上车', note: '矿车乘坐反馈', keys: ['mountAlready', 'mountMissing', 'mountSuccess', 'mountFailure'] },
  { command: '下车', note: '离开载具反馈', keys: ['dismountMissing', 'dismountSuccess', 'dismountFailure'] },
  { command: '清空', note: '背包清空反馈', keys: ['clearEmpty', 'clearSuccess', 'clearFailure'] },
  { command: '切换', note: '快捷栏切换反馈', keys: ['switchUsage', 'switchSuccess'] },
  { command: '定时灾厄之瓶', note: '定时饮用与状态反馈', keys: ['ominousUsage', 'ominousEnabled', 'ominousDisabled', 'ominousStatusOn', 'ominousStatusOff'] },
  { command: '定时放置', note: '定时放置与状态反馈', keys: ['periodicRightClickUsage', 'periodicRightClickEnabled', 'periodicRightClickDisabled', 'periodicRightClickStatusOn', 'periodicRightClickStatusOff'] },
  { command: '右键', note: '实体或方块交互反馈', keys: ['rightClickUsage', 'rightClickSuccess', 'rightClickFailure'] },
  { command: '放置', note: '单次放置反馈', keys: ['placeUsage', 'placeSuccess', 'placeFailure'] },
  { command: '定时任务', note: '自定义任务定时开关反馈', keys: ['taskUsage', 'taskScheduled', 'taskStopped'] },
  { command: '锁定 / 解锁 / 状态', note: '挂机锁定与定时状态反馈', keys: ['locked', 'lockUsage', 'alreadyLocked', 'lockSuccess', 'notLocked', 'adminUnlockRequired', 'unlockSuccess', 'scheduleStatus'] },
  { command: '指令', note: '服务器指令转发反馈', keys: ['forwardUsage', 'forwardInvalid', 'forwardNested', 'forwardDangerous', 'forwardHome'] },
  { command: '重启', note: 'Bot 重启反馈', keys: ['restartLocked', 'restarting'] },
  { command: '加白 / 加黑 / 去白 / 去黑 / 临时加白 / 临时加黑', note: '管理员权限管理反馈', keys: ['permissionAdded', 'permissionExists', 'permissionRemoved', 'permissionMissing', 'temporaryUsage', 'temporaryAdded'] },
  { command: '超级锁定 / 超级解锁', note: '管理员锁定反馈', keys: ['adminLockUsage', 'alreadyAdminLocked', 'adminLockSuccess', 'notAdminLocked', 'adminUnlockSuccess'] }
]

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
  $('changePassword').classList.toggle('hidden', data.user.authSource === 'cloud_store')
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', data.user.role !== 'admin'))
  await loadPlatformSettings()
  await loadAccountsData()
  await loadView()
}

async function loadPublicSettings () {
  const data = await request('/api/public-settings')
  state.registrationEnabled = Boolean(data.registrationEnabled)
  state.botCreationEnabled = data.botCreationEnabled !== false
  $('authRegisterTab').classList.toggle('hidden', !state.registrationEnabled)
  $('authModeTabs').classList.toggle('single', !state.registrationEnabled)
  $('authSsoHint').classList.toggle('hidden', state.registrationEnabled)
  if (!state.registrationEnabled && state.authMode === 'register') {
    state.authMode = 'login'
    document.querySelectorAll('[data-auth]').forEach(item => item.classList.toggle('active', item.dataset.auth === 'login'))
    $('authSubmit').textContent = '登录'
  }
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

function openPasswordDialog () {
  $('currentPassword').value = ''
  $('newPassword').value = ''
  $('confirmPassword').value = ''
  $('passwordError').textContent = ''
  $('passwordDialog').classList.remove('hidden')
}

function closePasswordDialog () {
  $('passwordDialog').classList.add('hidden')
}

async function changeOwnPassword () {
  $('passwordError').textContent = ''
  await post('/api/password', {
    currentPassword: $('currentPassword').value,
    newPassword: $('newPassword').value,
    confirmPassword: $('confirmPassword').value
  })
  closePasswordDialog()
  toast('密码已修改，请重新登录')
  setTimeout(() => location.reload(), 800)
}

async function loadTemplates () {
  const data = await request('/api/templates')
  state.templates = data.rows
  $('botTemplate').innerHTML = data.rows.map(row => `<option value="${esc(row.id)}">${esc(row.name)} · ${esc(templatePrice(row))}</option>`).join('')
  renderCreateVariables()
}

async function loadModules () {
  const data = await request('/api/modules')
  state.modules = data.rows
  $('botModules').innerHTML = state.modules.length ? state.modules.map(row => `<div class="module-option"><label><input type="checkbox" data-module-id="${esc(row.id)}"><span><strong>${esc(row.name)}</strong><small>${esc(templatePrice(row))}</small><em>${esc(row.description || '')}</em></span></label>${row.instructions ? `<p class="module-instructions">${esc(row.instructions)}</p>` : ''}${(row.help || []).length ? `<div class="module-help">${row.help.map(item => `<div><code>${esc(commandUsage(item.command))}</code><span>${esc(item.description)}</span></div>`).join('')}</div>` : ''}<div class="module-variable-grid">${moduleVariableInputs(row, {})}</div></div>`).join('') : '<div class="muted">管理员尚未发布功能模块。</div>'
}

async function loadBotSettings () {
  const data = await request('/api/user/bot-settings')
  state.botSettings = data.settings
  $('commandPrefix').value = data.settings.commandPrefix
  $('commandWhitelist').value = (data.settings.whitelist || []).join('\n')
}

async function saveBotAccess () {
  const whitelist = $('commandWhitelist').value.split(/\r?\n|[,，]/).map(value => value.trim()).filter(Boolean)
  const data = await post('/api/user/bot-settings', { commandPrefix: $('commandPrefix').value, whitelist })
  state.botSettings = data.settings
  $('commandWhitelist').value = data.settings.whitelist.join('\n')
  await loadModules()
  toast('白名单和命令前缀已热更新')
}

async function loadPlatformSettings () {
  if (state.user?.role === 'admin') {
    const data = await request('/api/admin/settings')
    state.modePrices = data
    $('smartHourlyPrice').value = data.smartHourlyPrice
    $('signinOncePrice').value = data.signinOncePrice
    $('maxRunningBots').value = data.maxRunningBots
    $('botCreationEnabled').checked = Boolean(data.botCreationEnabled)
    $('registrationEnabled').checked = Boolean(data.registrationEnabled)
  } else {
    const data = await request('/api/modes')
    state.modePrices = data.prices
  }
  updateModeFields()
}

async function saveBasePrice () {
  const data = await post('/api/admin/settings', { smartHourlyPrice: $('smartHourlyPrice').value, signinOncePrice: $('signinOncePrice').value, maxRunningBots: $('maxRunningBots').value, botCreationEnabled: $('botCreationEnabled').checked, registrationEnabled: $('registrationEnabled').checked })
  state.modePrices = data
  state.registrationEnabled = Boolean(data.registrationEnabled)
  state.botCreationEnabled = Boolean(data.botCreationEnabled)
  updateModeFields()
  toast('平台设置已保存')
}

function updateModeFields () {
  const signin = $('botMode').value === 'signin'
  $('modePriceHint').textContent = signin ? `${formatMomoc(state.modePrices?.signinOncePrice)} momoc / 次，成功后下线` : `${formatMomoc(state.modePrices?.smartHourlyPrice)} momoc / 1h，持续在线`
  $('botPrefixField').classList.toggle('hidden', signin)
}

function moduleVariableInputs (feature, values) {
  return (feature.variables || []).map(definition => variableInputsHtml([{ ...definition, key: `${feature.id}:${definition.key}` }], { [`${feature.id}:${definition.key}`]: values?.[definition.key] })).join('')
}

function collectModuleSelections (attribute) {
  return Array.from(document.querySelectorAll(`input[${attribute}]:checked`)).map(input => {
    const moduleId = input.getAttribute(attribute)
    const variables = {}
    input.closest('.module-option').querySelectorAll('[data-variable-key]').forEach(field => {
      variables[field.dataset.variableKey.split(':').slice(1).join(':')] = field.type === 'checkbox' ? field.checked : field.value
    })
    return { moduleId, variables }
  })
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

function smartScheduleHtml (bot) {
  if (bot.mode !== 'smart') return '<span class="muted">-</span>'
  const schedules = bot.smartSchedules || {}
  const automation = schedules.automation || {}
  const rows = []
  if (automation.ominousBottleEnabled) rows.push({ label: '定时灾厄之瓶', action: 'stop_ominous' })
  if (automation.periodicRightClickEnabled) rows.push({ label: `定时放置 (${automation.periodicRightClickX}, ${automation.periodicRightClickY}, ${automation.periodicRightClickZ}) · ${automation.periodicRightClickIntervalTicks}gt`, action: 'stop_periodic_right_click' })
  for (const task of schedules.tasks || []) rows.push({ label: `定时任务 ${task.name} · ${task.intervalTicks}gt`, action: 'stop_task', name: task.name })
  if (!rows.length) return '<div class="smart-schedules"><span class="muted">当前无定时任务</span></div>'
  return `<div class="smart-schedules">${rows.map(row => `<div class="smart-schedule-row"><span>${esc(row.label)}</span><button type="button" class="danger" data-stop-smart-schedule="${esc(row.action)}" data-smart-schedule-bot="${esc(bot.id)}"${row.name ? ` data-smart-schedule-name="${esc(row.name)}"` : ''}>停止</button></div>`).join('')}</div>`
}

async function loadBots () {
  const data = await request('/api/bots')
  state.bots = data.rows
  $('createBot').disabled = state.botCreationEnabled === false
  $('createBot').title = $('createBot').disabled ? '平台已暂停创建新 Bot' : ''
  $('botSummary').textContent = `${data.rows.length} 个机器人 · ${data.rows.filter(row => row.runtimeState === 'online').length} 个在线${state.botCreationEnabled === false ? ' · 平台已暂停创建' : ''}`
  $('botsTable').innerHTML = data.rows.length
    ? '<table><thead><tr><th>机器人</th><th>服务器</th><th>模板</th><th>定时任务</th><th>状态</th><th>OAuth2</th><th>计费</th><th>操作</th></tr></thead><tbody>' + data.rows.map(bot => {
        const oauth = bot.oauth
          ? `<div class="oauth"><a href="${esc(bot.oauth.verificationUri)}" target="_blank" rel="noreferrer">打开 Microsoft 登录</a><br><code>${esc(bot.oauth.userCode)}</code></div>`
          : '<span class="muted">-</span>'
        const action = bot.desiredState === 'running'
          ? `<button data-stop="${esc(bot.id)}">停止</button>`
          : `<button class="primary" data-start="${esc(bot.id)}">启动</button>`
        const variables = bot.variableDefinitions?.length ? `<button data-bot-variables="${esc(bot.id)}">变量</button>` : ''
        const schedule = bot.billingMode === 'once' && bot.allowScheduling ? `<button data-bot-schedule="${esc(bot.id)}">计划</button>` : ''
        const permissions = bot.mode === 'smart' ? `<button data-smart-permissions="${esc(bot.id)}">权限</button>` : ''
        const logs = `<button data-bot-logs="${esc(bot.id)}">日志</button>`
        const modeName = bot.mode === 'signin' ? '签到 Bot' : '智能 Bot'
        const modeDetail = bot.mode === 'signin' ? `命令：${bot.modeVariables?.command || '-'}` : '持续在线 · 消息解析'
        return `<tr><td><strong>${esc(bot.label)}</strong><div class="muted">${esc(bot.microsoftEmail)}</div><div class="muted">${esc(bot.accountMinecraftName || bot.minecraftName || '')}</div></td><td>${esc(bot.serverHost)}:${esc(bot.serverPort)}<div class="muted">${esc(bot.minecraftVersion || '自动识别')}</div></td><td><strong>${esc(modeName)}</strong><div class="price-hint">${esc(templatePrice(bot))}</div><div class="muted">${esc(modeDetail)}</div>${bot.scheduleEnabled ? '<div class="positive">计划已启用</div>' : ''}</td><td>${smartScheduleHtml(bot)}</td><td><span class="status ${esc(bot.runtimeState)}">${esc(statusLabel(bot.runtimeState))}</span><div class="muted">${esc(bot.lastError || '')}</div></td><td>${oauth}</td><td>${bot.billingMode === 'once' ? '按次成功' : `${esc(bot.billedMinutes)} 分钟`}</td><td><div class="actions">${action}${permissions}${schedule}${logs}<button class="danger" data-delete="${esc(bot.id)}">删除</button></div></td></tr>`
      }).join('') + '</tbody></table>'
    : '<div class="empty">还没有机器人。</div>'
  bindBotActions()
}

function managedBotCards (rows) {
  if (!rows.length) return '<div class="empty managed-empty">当前没有机器人。</div>'
  return rows.map(bot => {
    const action = bot.desiredState === 'running'
      ? `<button data-stop="${esc(bot.id)}">停止</button>`
      : `<button class="primary" data-start="${esc(bot.id)}">启动</button>`
    const permissions = bot.mode === 'smart' ? `<button data-smart-permissions="${esc(bot.id)}">权限</button>` : ''
    return `<article class="managed-bot-card">
      <div class="managed-bot-card-head"><div><strong>${esc(bot.label)}</strong><span>${esc(bot.ownerUsername || '-')}</span></div><span class="status ${esc(bot.runtimeState)}">${esc(statusLabel(bot.runtimeState))}</span></div>
      <dl><div><dt>账号</dt><dd>${esc(bot.accountMinecraftName || bot.microsoftEmail || '-')}</dd></div><div><dt>服务器</dt><dd>${esc(bot.serverHost)}:${esc(bot.serverPort)}</dd></div><div><dt>类型</dt><dd>${bot.mode === 'signin' ? '签到 Bot' : '智能 Bot'}</dd></div></dl>
      <div class="managed-bot-schedules"><strong>定时任务</strong>${smartScheduleHtml(bot)}</div>
      ${bot.lastError ? `<p class="managed-bot-error">${esc(bot.lastError)}</p>` : ''}
      <div class="actions">${action}${permissions}<button data-bot-logs="${esc(bot.id)}">日志</button><button class="danger" data-delete="${esc(bot.id)}">删除</button></div>
    </article>`
  }).join('')
}

async function loadManagedBots () {
  const data = await request('/api/bots?all=1')
  state.managedBots = data.rows
  const running = data.rows.filter(row => row.desiredState === 'running')
  const stopped = data.rows.filter(row => row.desiredState !== 'running')
  $('managedBotSummary').textContent = `${data.rows.length} 个机器人 · ${running.length} 个运行中 · ${stopped.length} 个已停止`
  $('managedRunningCount').textContent = running.length
  $('managedStoppedCount').textContent = stopped.length
  $('managedRunningBots').innerHTML = managedBotCards(running)
  $('managedStoppedBots').innerHTML = managedBotCards(stopped)
  bindBotActions()
}

const findBot = id => state.view === 'management'
  ? state.managedBots.find(row => row.id === id) || state.bots.find(row => row.id === id)
  : state.bots.find(row => row.id === id) || state.managedBots.find(row => row.id === id)

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
  document.querySelectorAll('[data-smart-permissions]').forEach(btn => {
    btn.onclick = () => openSmartPermissionDialog(btn.dataset.smartPermissions).catch(error => toast(error.message))
  })
  document.querySelectorAll('[data-stop-smart-schedule]').forEach(btn => {
    btn.onclick = async () => {
      try {
        await post('/api/smart/automation', { botId: btn.dataset.smartScheduleBot, action: btn.dataset.stopSmartSchedule, name: btn.dataset.smartScheduleName || '' })
        toast('定时任务已停止')
        if (state.view === 'management') {
          if (state.managementTab === 'managedBots') await loadManagedBots()
          else await loadOverview()
        } else await loadBots()
      } catch (error) { toast(error.message) }
    }
  })
  document.querySelectorAll('[data-bot-logs]').forEach(btn => {
    btn.onclick = () => openBotLogDialog(btn.dataset.botLogs)
  })
  document.querySelectorAll('[data-bot-modules]').forEach(btn => {
    btn.onclick = () => openBotModuleDialog(btn.dataset.botModules)
  })
}

function openBotLogDialog (id) {
  let modal = $('botLogDialog')
  if (!modal) {
    modal = document.createElement('div')
    modal.id = 'botLogDialog'
    modal.className = 'modal hidden'
    modal.innerHTML = '<div class="dialog log-dialog" role="dialog" aria-modal="true"><div class="dialog-head"><strong id="botLogTitle"></strong><div class="actions"><button id="refreshBotLogs">刷新</button><button id="closeBotLogs" class="icon-button" title="关闭">×</button></div></div><div id="botLogRows" class="bot-log-rows"></div></div>'
    document.body.append(modal)
    modal.addEventListener('click', event => {
      if (event.target === modal || event.target.id === 'closeBotLogs') modal.classList.add('hidden')
    })
  }

  const render = () => {
    const bot = findBot(id)
    if (!bot) return modal.classList.add('hidden')
    $('botLogTitle').textContent = `${bot.label} - 最近日志`
    const rows = $('botLogRows')
    rows.replaceChildren()
    const logs = Array.isArray(bot.logs) ? bot.logs : []
    if (!logs.length) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '当前进程还没有日志。'
      rows.append(empty)
      return
    }
    for (const entry of logs) {
      const row = document.createElement('div')
      row.className = `bot-log ${String(entry.level || 'info')}`
      const at = document.createElement('time')
      at.textContent = new Date(Number(entry.at) || 0).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
      const level = document.createElement('span')
      level.textContent = String(entry.level || 'info')
      const message = document.createElement('pre')
      message.textContent = String(entry.message || '')
      row.append(at, level, message)
      rows.append(row)
    }
    rows.scrollTop = rows.scrollHeight
  }

  $('refreshBotLogs').onclick = async () => {
    try {
      if (state.managedBots.some(row => row.id === id)) await loadManagedBots()
      else await loadBots()
      render()
    } catch (error) {
      toast(error.message)
    }
  }
  render()
  modal.classList.remove('hidden')
}

function smartRoleLabel (role) {
  return { whitelist: '白名单', blacklist: '黑名单', admin: '超管' }[role] || role
}

function smartLockText (lock) {
  if (lock?.adminLocked) return `超级锁定：${lock.lockedBy || '-'} · ${lock.reason || '无备注'}`
  if (lock?.locked) return `已锁定：${lock.lockedBy || '-'} · ${lock.reason || '无备注'}`
  return '当前未锁定'
}

async function openSmartPermissionDialog (id) {
  state.editingPermissionBotId = id
  $('smartPermissionError').textContent = ''
  $('smartPermissionPlayer').value = ''
  $('smartPermissionMinutes').value = ''
  $('smartPermissionDialog').classList.remove('hidden')
  await loadSmartPermissions()
}

function closeSmartPermissionDialog () {
  $('smartPermissionDialog').classList.add('hidden')
  state.editingPermissionBotId = ''
}

async function loadSmartPermissions () {
  const data = await request(`/api/smart/permissions?botId=${encodeURIComponent(state.editingPermissionBotId)}`)
  $('smartPermissionTitle').textContent = `${data.bot.label} · 智能 Bot 权限`
  $('smartLockState').textContent = smartLockText(data.lock)
  $('smartCommandPrefix').value = data.settings?.commandPrefix || ''
  $('smartPermissionRows').innerHTML = data.rows.length
    ? '<table><thead><tr><th>玩家</th><th>权限</th><th>有效期</th><th></th></tr></thead><tbody>' + data.rows.map(row => `<tr><td><strong>${esc(row.playerName)}</strong></td><td>${esc(smartRoleLabel(row.role))}</td><td>${row.expiresAt ? esc(new Date(Number(row.expiresAt)).toLocaleString('zh-CN')) : '永久'}</td><td><button class="danger" data-remove-smart-player="${esc(row.playerName)}" data-remove-smart-role="${esc(row.role)}">移除</button></td></tr>`).join('') + '</tbody></table>'
    : '<div class="empty">尚未设置游戏内权限。</div>'
  document.querySelectorAll('[data-remove-smart-player]').forEach(btn => {
    btn.onclick = () => removeSmartPermission(btn.dataset.removeSmartPlayer, btn.dataset.removeSmartRole).catch(error => { $('smartPermissionError').textContent = error.message })
  })
}

async function addSmartPermission () {
  $('smartPermissionError').textContent = ''
  await post('/api/smart/permissions', {
    botId: state.editingPermissionBotId,
    action: 'add',
    playerName: $('smartPermissionPlayer').value,
    role: $('smartPermissionRole').value,
    minutes: $('smartPermissionMinutes').value
  })
  $('smartPermissionPlayer').value = ''
  $('smartPermissionMinutes').value = ''
  await loadSmartPermissions()
}

async function removeSmartPermission (playerName, role) {
  await post('/api/smart/permissions', { botId: state.editingPermissionBotId, action: 'remove', playerName, role })
  await loadSmartPermissions()
}

async function saveSmartCommandPrefix () {
  const data = await post('/api/smart/permissions', {
    botId: state.editingPermissionBotId,
    action: 'settings',
    commandPrefix: $('smartCommandPrefix').value
  })
  $('smartCommandPrefix').value = data.settings.commandPrefix
  toast('命令前缀已热更新')
}

function taskArgumentHint (command) {
  return { 上车: '无需参数', 下车: '无需参数', 清空: '无需参数', 切换: '1-9', 放置: 'x y z', 右键: '玩家名 或 x y z', 指令: '服务器指令' }[command] || ''
}

function renderTaskEditor (actions = [{ command: '放置', args: '' }], waits = []) {
  $('taskSteps').innerHTML = actions.map((action, index) => {
    const commandOptions = TASK_COMMANDS.map(command => `<option value="${command}"${command === action.command ? ' selected' : ''}>${command}</option>`).join('')
    const actionRow = `<div class="task-action-row" data-task-action><span class="step-number">${index + 1}</span><label>平台命令<select data-task-command>${commandOptions}</select></label><label class="task-args">参数<input data-task-args value="${esc(action.args || '')}" placeholder="${esc(taskArgumentHint(action.command))}"${['上车', '下车', '清空'].includes(action.command) ? ' disabled' : ''}></label><button type="button" class="danger task-remove" data-remove-task-step aria-label="删除第 ${index + 1} 个命令">删除</button></div>`
    if (index === actions.length - 1) return actionRow
    const wait = Number(waits[index] || 5)
    const waitOptions = [1, 2, 5, 10, 20, 40, 100, 200].map(value => `<option value="${value}"${value === wait ? ' selected' : ''}>${value}gt</option>`).join('')
    return `${actionRow}<div class="task-wait-row"><span>然后等待</span><select data-task-wait aria-label="第 ${index + 1} 和 ${index + 2} 个命令之间的等待时间">${waitOptions}</select><span>再执行下一条</span></div>`
  }).join('')
  bindTaskEditor()
}

function bindTaskEditor () {
  document.querySelectorAll('[data-task-command]').forEach(select => {
    select.onchange = () => {
      const input = select.closest('[data-task-action]').querySelector('[data-task-args]')
      input.placeholder = taskArgumentHint(select.value)
      input.disabled = ['上车', '下车', '清空'].includes(select.value)
      if (input.disabled) input.value = ''
    }
  })
  document.querySelectorAll('[data-remove-task-step]').forEach((button, index) => {
    button.onclick = () => {
      const draft = collectTaskDraft()
      draft.actions.splice(index, 1)
      if (index < draft.waits.length) draft.waits.splice(index, 1); else draft.waits.pop()
      renderTaskEditor(draft.actions.length ? draft.actions : [{ command: '放置', args: '' }], draft.waits)
    }
  })
}

function collectTaskDraft () {
  return {
    actions: [...document.querySelectorAll('[data-task-action]')].map(row => ({ command: row.querySelector('[data-task-command]').value, args: row.querySelector('[data-task-args]').value.trim() })),
    waits: [...document.querySelectorAll('[data-task-wait]')].map(select => Number(select.value))
  }
}

function collectTaskSteps () {
  const draft = collectTaskDraft()
  const steps = []
  draft.actions.forEach((action, index) => {
    steps.push({ type: 'command', command: action.command, args: action.args ? action.args.split(/\s+/) : [] })
    if (index < draft.actions.length - 1) steps.push({ type: 'wait', ticks: draft.waits[index] || 1 })
  })
  return steps
}

async function loadTasks () {
  if (!state.bots.length) await loadBots()
  const smartBots = state.bots.filter(row => row.mode === 'smart')
  $('taskBot').innerHTML = smartBots.map(row => `<option value="${esc(row.id)}">${esc(row.label)}</option>`).join('')
  if (!smartBots.length) { $('taskRows').innerHTML = '<div class="empty">请先创建智能 Bot。</div>'; return }
  if (!smartBots.some(row => row.id === state.editingTaskBotId)) state.editingTaskBotId = smartBots[0].id
  $('taskBot').value = state.editingTaskBotId
  if (!$('taskSteps').children.length) renderTaskEditor()
  const data = await request(`/api/smart/tasks?botId=${encodeURIComponent(state.editingTaskBotId)}`)
  $('taskRows').innerHTML = data.rows.length ? `<table><thead><tr><th>任务</th><th>命令数</th><th>游戏内调用</th><th></th></tr></thead><tbody>${data.rows.map(row => `<tr><td><strong>${esc(row.name)}</strong></td><td>${Math.ceil(row.steps.length / 2)}</td><td><code>${esc(row.name)}</code><div class="muted">定时任务 ${esc(row.name)} 5</div></td><td><button class="danger" data-delete-task="${esc(row.name)}">删除</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">尚未创建任务。</div>'
  document.querySelectorAll('[data-delete-task]').forEach(btn => { btn.onclick = async () => { await post('/api/smart/tasks', { botId: state.editingTaskBotId, action: 'delete', name: btn.dataset.deleteTask }); await loadTasks() } })
}

async function saveTask () {
  $('taskError').textContent = ''
  try {
    await post('/api/smart/tasks', { botId: $('taskBot').value, name: $('taskName').value, steps: collectTaskSteps() })
    $('taskName').value = ''; renderTaskEditor()
    await loadTasks(); toast('任务已保存')
  } catch (error) { $('taskError').textContent = error.message; throw error }
}

async function loadMessages () {
  const data = await request('/api/smart/messages')
  const values = { ...MESSAGE_DEFAULTS, ...(data.overrides || {}) }
  const field = key => {
    const placeholders = [...MESSAGE_DEFAULTS[key].matchAll(/\{[a-zA-Z][a-zA-Z0-9]*\}/g)].map(match => match[0]).join(' ')
    const changed = Object.prototype.hasOwnProperty.call(data.overrides || {}, key)
    return `<label class="message-field"><span><strong>${esc(MESSAGE_LABELS[key] || key)}</strong><small>${esc(key)}${placeholders ? ` · 可用 ${esc(placeholders)}` : ''}</small></span><div class="message-input-actions"><input data-message-key="${esc(key)}" value="${esc(values[key])}" maxlength="256"><button type="button" data-reset-message="${esc(key)}"${changed ? '' : ' disabled'}>重置</button></div></label>`
  }
  const grouped = new Set(MESSAGE_GROUPS.flatMap(group => group.keys))
  const groups = [...MESSAGE_GROUPS, { command: '其他', note: '未归类的消息', keys: Object.keys(MESSAGE_DEFAULTS).filter(key => !grouped.has(key)) }]
    .filter(group => group.keys.length)
  $('messageFields').innerHTML = groups.map(group => `<section class="message-command-group"><div class="message-command-head"><div><code>${esc(group.command)}</code><span>${esc(group.note)}</span></div><small>${group.keys.length} 条消息</small></div><div class="message-command-fields">${group.keys.map(field).join('')}</div></section>`).join('')
  document.querySelectorAll('[data-message-key]').forEach(input => {
    input.oninput = () => {
      const button = document.querySelector(`[data-reset-message="${CSS.escape(input.dataset.messageKey)}"]`)
      if (button) button.disabled = input.value === MESSAGE_DEFAULTS[input.dataset.messageKey]
    }
  })
  document.querySelectorAll('[data-reset-message]').forEach(button => {
    button.onclick = () => resetMessage(button.dataset.resetMessage).catch(error => { $('messageError').textContent = error.message })
  })
}

async function saveMessages () {
  $('messageError').textContent = ''
  const overrides = Object.fromEntries([...document.querySelectorAll('[data-message-key]')]
    .filter(input => input.value !== MESSAGE_DEFAULTS[input.dataset.messageKey])
    .map(input => [input.dataset.messageKey, input.value]))
  await post('/api/smart/messages', { overrides })
  await loadMessages()
  toast('消息文本已热更新')
}

async function resetMessage (key) {
  await post('/api/smart/messages', { resetKeys: [key] })
  await loadMessages()
  toast('已恢复该条默认消息')
}

async function resetMessages () {
  await post('/api/smart/messages', { reset: true })
  await loadMessages()
  toast('已恢复默认消息')
}

function openBotModuleDialog (id) {
  const bot = state.bots.find(row => row.id === id)
  if (!bot) return
  state.editingModuleBotId = id
  const selected = new Set((bot.modules || []).map(row => row.id))
  $('editBotModules').innerHTML = state.modules.map(row => { const current = (bot.modules || []).find(item => item.id === row.id); return `<div class="module-option"><label><input type="checkbox" data-edit-module-id="${esc(row.id)}"${selected.has(row.id) ? ' checked' : ''}><span><strong>${esc(row.name)}</strong><small>${esc(templatePrice(row))}</small><em>${esc(row.description || '')}</em></span></label>${row.instructions ? `<p class="module-instructions">${esc(row.instructions)}</p>` : ''}${(row.help || []).length ? `<div class="module-help">${row.help.map(item => `<div><code>${esc(commandUsage(item.command))}</code><span>${esc(item.description)}</span></div>`).join('')}</div>` : ''}<div class="module-variable-grid">${moduleVariableInputs(row, current?.variables || {})}</div></div>` }).join('')
  $('botModuleDialog').classList.remove('hidden')
}

function closeBotModuleDialog () {
  $('botModuleDialog').classList.add('hidden')
  state.editingModuleBotId = ''
}

async function saveBotModules () {
  const modules = collectModuleSelections('data-edit-module-id')
  await post('/api/bots/modules', { id: state.editingModuleBotId, modules })
  closeBotModuleDialog()
  await loadBots()
  toast('功能模块已更新')
}

async function botAction (path, id) {
  try {
    await post(path, { id })
    if (state.view === 'management' && state.managementTab === 'managedBots') await loadManagedBots()
    else await loadBots()
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
      mode: $('botMode').value,
      commandPrefix: $('botCommandPrefix').value
    })
    toast('机器人已创建')
    $('botLabel').value = ''
    $('botCommandPrefix').value = ''
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
  $('usersTable').innerHTML = '<table><thead><tr><th>用户</th><th>角色</th><th>momoc</th><th>余额调整</th><th>登录方式</th></tr></thead><tbody>' + data.rows.map(row => `<tr><td><strong>${esc(row.username)}</strong></td><td>${esc(row.role)}</td><td>${formatMomoc(row.momoc)}${Number(row.reservedMomoc || 0) > 0 ? `<div class="muted">已预留 ${formatMomoc(row.reservedMomoc)}</div>` : ''}</td><td><div class="actions"><input style="width:120px" type="number" step="any" data-amount="${esc(row.id)}" placeholder="正负数量"><button class="primary" data-adjust="${esc(row.id)}">确认</button></div></td><td>${row.authSource === 'cloud_store' ? '<span class="muted">云仓库登录</span>' : `<div class="actions"><input style="width:180px" type="password" data-password="${esc(row.id)}" placeholder="至少 8 位新密码"><button data-reset-password="${esc(row.id)}">重置</button></div>`}</td></tr>`).join('') + '</tbody></table>'
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
  document.querySelectorAll('[data-reset-password]').forEach(btn => {
    btn.onclick = async () => {
      try {
        const input = document.querySelector(`[data-password="${CSS.escape(btn.dataset.resetPassword)}"]`)
        const data = await post('/api/admin/password', { userId: btn.dataset.resetPassword, password: input.value })
        toast(data.selfReset ? '密码已重置，请使用新密码重新登录' : '用户密码已重置')
        if (data.selfReset) setTimeout(() => location.reload(), 900)
      } catch (error) { toast(error.message) }
    }
  })
}

async function loadPlatformAdmins () {
  const data = await request('/api/admin/roles')
  $('platformAdminsTable').innerHTML = data.rows.length
    ? '<table><thead><tr><th>玩家 ID</th><th>身份来源</th><th>操作</th></tr></thead><tbody>' + data.rows.map(row => {
        const protectedAdmin = row.username.toLowerCase() === String(data.rootUsername || '').toLowerCase()
        const self = row.id === state.user?.id
        const action = protectedAdmin
          ? '<span class="muted">根管理员</span>'
          : self
              ? '<span class="muted">当前账号</span>'
              : `<button class="danger" data-remove-platform-admin="${esc(row.id)}">移除管理员</button>`
        return `<tr><td><strong>${esc(row.username)}</strong></td><td>${row.authSource === 'cloud_store' ? '云仓库' : '本地账号'}</td><td>${action}</td></tr>`
      }).join('') + '</tbody></table>'
    : '<div class="empty">暂无平台管理员。</div>'
  document.querySelectorAll('[data-remove-platform-admin]').forEach(button => {
    button.onclick = async () => {
      if (!confirm('确认移除该玩家的平台管理员权限？')) return
      try {
        await post('/api/admin/roles', { action: 'remove', userId: button.dataset.removePlatformAdmin })
        toast('平台管理员已移除')
        await loadPlatformAdmins()
      } catch (error) { toast(error.message) }
    }
  })
}

async function addPlatformAdmin () {
  await post('/api/admin/roles', { action: 'add', username: $('platformAdminUsername').value })
  $('platformAdminUsername').value = ''
  toast('平台管理员已添加')
  await loadPlatformAdmins()
}

async function loadOverview () {
  const data = await request('/api/admin/overview')
  const stats = data.stats
  $('overviewStats').innerHTML = [
    ['用户', stats.users],
    ['微软账号', `${stats.authorizedAccounts} / ${stats.accounts} 已授权`],
    ['Bot', `${stats.runningBots} / ${stats.bots} 运行中`],
    ['智能 Bot 上限', `${stats.runningSmartBots} / ${stats.maxRunningBots || '不限'}`],
    ['创建新 Bot', stats.botCreationEnabled ? '允许' : '已暂停'],
    ['累计消费', `${formatMomoc(stats.totalSpent)} momoc`]
  ].map(([label, value]) => `<div class="overview-stat"><span>${label}</span><strong>${value}</strong></div>`).join('')

  $('overviewAccounts').innerHTML = data.accounts.length
    ? '<table><thead><tr><th>用户</th><th>Microsoft 账号</th><th>Minecraft 名称</th><th>授权状态</th><th>Bot 数量</th></tr></thead><tbody>' + data.accounts.map(row => `<tr><td><strong>${esc(row.username)}</strong></td><td>${esc(row.email)}</td><td>${esc(row.minecraftName || '-')}</td><td><span class="status ${esc(row.authState)}">${esc(row.authState)}</span>${row.lastError ? `<div class="error">${esc(row.lastError)}</div>` : ''}</td><td>${row.botCount}</td></tr>`).join('') + '</tbody></table>'
    : '<div class="empty">暂无微软账号授权。</div>'

  $('overviewBots').innerHTML = data.bots.length
    ? '<table><thead><tr><th>用户</th><th>Bot</th><th>微软账号</th><th>模式</th><th>定时任务</th><th>状态</th><th>挂机锁定</th><th>已设置前缀</th><th>累计分钟</th></tr></thead><tbody>' + data.bots.map(row => {
        const lockText = row.mode !== 'smart' ? '-' : row.lock?.adminLocked ? `超级锁定 · ${row.lock.lockedBy || '-'}` : row.lock?.locked ? `挂机中 · ${row.lock.lockedBy || '-'}` : '未锁定'
        const prefix = row.mode === 'smart' ? (row.commandPrefix || '未设置') : '-'
        return `<tr><td><strong>${esc(row.ownerUsername)}</strong></td><td>${esc(row.label)}</td><td>${esc(row.accountMinecraftName || row.microsoftEmail)}</td><td>${row.mode === 'signin' ? '签到 Bot' : '智能 Bot'}</td><td>${smartScheduleHtml(row)}</td><td><span class="status ${esc(row.runtimeState)}">${esc(statusLabel(row.runtimeState))}</span></td><td>${esc(lockText)}${row.lock?.reason ? `<div class="muted">${esc(row.lock.reason)}</div>` : ''}</td><td><code>${esc(prefix)}</code></td><td>${Number(row.billedMinutes || 0)}</td></tr>`
      }).join('') + '</tbody></table>'
    : '<div class="empty">暂无 Bot。</div>'

  bindBotActions()

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
  await loadModules()
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

async function loadModuleAdmin (preferredId = state.moduleId) {
  const data = await request('/api/admin/modules')
  state.moduleAdminRows = data.rows
  $('moduleSummary').textContent = `${data.rows.length} 个模块`
  $('moduleList').innerHTML = data.rows.length ? data.rows.map(row => `<button data-feature-module="${esc(row.id)}"><strong>${esc(row.name)}</strong><span class="price-hint">${esc(templatePrice(row))}</span><span class="muted">${row.enabled ? '已启用' : '已停用'}</span></button>`).join('') : '<div class="empty">暂无功能模块。</div>'
  document.querySelectorAll('[data-feature-module]').forEach(btn => { btn.onclick = () => editModule(btn.dataset.featureModule) })
  const selected = data.rows.find(row => row.id === preferredId) || data.rows[0]
  if (selected) editModule(selected.id); else clearModule()
}

async function loadPlatformFiles () {
  const data = await request('/api/admin/platform-files')
  $('platformFileList').innerHTML = data.rows.map(row => row.type === 'directory' ? `<div class="file-entry directory" style="padding-left:${10 + row.depth * 16}px"><span class="file-icon">▸</span><span class="file-name">${esc(row.name)}</span></div>` : `<button class="file-entry" data-platform-file="${esc(row.path)}" style="padding-left:${10 + row.depth * 16}px"><span class="file-icon">·</span><span class="file-name">${esc(row.name)}</span></button>`).join('')
  document.querySelectorAll('[data-platform-file]').forEach(btn => { btn.onclick = () => openPlatformFile(btn.dataset.platformFile) })
}

async function openPlatformFile (file) {
  const data = await request(`/api/admin/platform-files?path=${encodeURIComponent(file)}`)
  state.platformFilePath = file
  $('platformFilePath').textContent = file
  $('platformFileContent').value = data.file.content
  $('platformFileContent').disabled = false
  $('savePlatformFile').disabled = false
}

async function savePlatformFile () {
  if (!state.platformFilePath) return
  await post('/api/admin/platform-files/save', { path: state.platformFilePath, content: $('platformFileContent').value })
  toast('代码已原子更新；当前挂机 Bot 不受影响，新代码下次启动生效')
}

function editModule (id) {
  const row = state.moduleAdminRows.find(item => item.id === id)
  if (!row) return
  state.moduleId = id
  $('moduleId').value = row.id
  $('moduleName').value = row.name
  $('moduleDescription').value = row.description
  $('moduleBillingMode').value = row.billingMode
  $('modulePrice').value = row.priceMomoc
  $('moduleVariables').value = JSON.stringify(row.variables || [], null, 2)
  $('moduleSource').value = row.source || ''
  $('moduleMetadata').innerHTML = `<h2>${esc(row.name)}</h2><p>${esc(row.description || '')}</p><div class="price-hint">${esc(templatePrice(row))}</div><p>${esc(row.instructions || '')}</p>${(row.help || []).length ? `<table><thead><tr><th>指令 / 触发</th><th>使用说明</th></tr></thead><tbody>${row.help.map(item => `<tr><td><code>${esc(item.command)}</code></td><td>${esc(item.description)}</td></tr>`).join('')}</tbody></table>` : ''}`
}

function clearModule () {
  state.moduleId = ''
  $('moduleId').value = ''
  $('moduleName').value = ''
  $('moduleDescription').value = ''
  $('moduleBillingMode').value = 'hourly'
  $('modulePrice').value = '0'
  $('moduleVariables').value = '[]'
  $('moduleMetadata').innerHTML = '<div class="empty">保存后自动解析模块名称、说明、指令、变量和计费信息。</div>'
  $('moduleSource').value = `module.exports = defineModule({
  name: '新功能模块',
  description: '向用户说明这个模块能做什么',
  instructions: '详细说明使用步骤、前置条件和注意事项',
  help: [
    { command: '!示例', description: '触发示例动作' }
  ],
  billing: { mode: 'hourly', priceMomoc: 0.03 },
  variables: []
}, ({ bot, variables, platform, command, message, every, on }) => {
  command({ pattern: /^!示例$/, channels: ['public', 'private'] }, async event => {
    bot.chat('已执行示例动作')
    // 按次模块在动作真正成功后调用 platform.success('执行结果')
  })

  // every(31 * 60 * 1000, async () => { ... })
})
`
}

async function saveModule () {
  const data = await post('/api/admin/modules/save', { id: $('moduleId').value || undefined, source: $('moduleSource').value, enabled: true })
  await loadModuleAdmin(data.module.id)
  await loadModules()
  toast('功能模块已保存')
}

async function deleteModule () {
  if (!state.moduleId || !confirm('确定删除这个功能模块吗？')) return
  await post('/api/admin/modules/delete', { id: state.moduleId })
  state.moduleId = ''
  await loadModuleAdmin()
  await loadModules()
  toast('功能模块已删除')
}

async function loadView () {
  const managed = state.view === 'management'
  const targetView = managed ? state.managementTab : state.view
  document.querySelectorAll('.view').forEach(el => el.classList.add('hidden'))
  $(targetView + 'View').classList.remove('hidden')
  $('managementNav').classList.toggle('hidden', !managed)
  document.querySelectorAll('nav [data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === state.view))
  document.querySelectorAll('[data-management-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.managementTab === state.managementTab))
  if (targetView === 'bots') await loadBots()
  if (targetView === 'accounts') await loadAccounts()
  if (targetView === 'tasks') await loadTasks()
  if (targetView === 'messages') await loadMessages()
  if (targetView === 'ledger') await loadLedger()
  if (targetView === 'overview') await loadOverview()
  if (targetView === 'managedBots') await loadManagedBots()
  if (targetView === 'users') await loadUsers()
  if (targetView === 'admins') await loadPlatformAdmins()
  if (targetView === 'modules') await loadModuleAdmin()
  if (targetView === 'code') await loadPlatformFiles()
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
$('changePassword').onclick = openPasswordDialog
$('closePasswordDialog').onclick = closePasswordDialog
$('cancelPasswordDialog').onclick = closePasswordDialog
$('savePassword').onclick = () => changeOwnPassword().catch(error => { $('passwordError').textContent = error.message })
$('confirmPassword').onkeydown = event => { if (event.key === 'Enter') changeOwnPassword().catch(error => { $('passwordError').textContent = error.message }) }
$('passwordDialog').onclick = event => { if (event.target === $('passwordDialog')) closePasswordDialog() }
document.querySelectorAll('nav [data-view]').forEach(btn => {
  btn.onclick = () => {
    if (state.view === 'templates' && !confirmDiscard()) return
    state.view = btn.dataset.view
    loadView().catch(error => toast(error.message))
  }
})
document.querySelectorAll('[data-management-tab]').forEach(btn => {
  btn.onclick = () => {
    state.managementTab = btn.dataset.managementTab
    loadView().catch(error => toast(error.message))
  }
})
$('createBot').onclick = createBot
$('botMode').onchange = updateModeFields
$('createAccount').onclick = createAccount
$('refreshAccounts').onclick = loadAccounts
$('botTemplate').onchange = renderCreateVariables
$('refreshBots').onclick = loadBots
$('refreshManagedBots').onclick = () => loadManagedBots().catch(error => toast(error.message))
$('refreshTasks').onclick = () => loadTasks().catch(error => toast(error.message))
$('taskBot').onchange = () => { state.editingTaskBotId = $('taskBot').value; loadTasks().catch(error => toast(error.message)) }
$('saveTask').onclick = () => saveTask().catch(error => toast(error.message))
$('addTaskStep').onclick = () => {
  const draft = collectTaskDraft()
  draft.actions.push({ command: '放置', args: '' })
  draft.waits.push(5)
  renderTaskEditor(draft.actions, draft.waits)
}
$('refreshMessages').onclick = () => loadMessages().catch(error => toast(error.message))
$('saveMessages').onclick = () => saveMessages().catch(error => { $('messageError').textContent = error.message })
$('resetMessages').onclick = () => resetMessages().catch(error => { $('messageError').textContent = error.message })
$('refreshLedger').onclick = loadLedger
$('refreshOverview').onclick = loadOverview
$('refreshUsers').onclick = loadUsers
$('refreshPlatformAdmins').onclick = loadPlatformAdmins
$('addPlatformAdmin').onclick = () => addPlatformAdmin().catch(error => toast(error.message))
$('platformAdminUsername').onkeydown = event => { if (event.key === 'Enter') addPlatformAdmin().catch(error => toast(error.message)) }
$('refreshTemplates').onclick = () => { if (confirmDiscard()) loadTemplateAdmin().catch(error => toast(error.message)) }
$('refreshModules').onclick = () => loadModuleAdmin().catch(error => toast(error.message))
$('newModule').onclick = clearModule
$('saveModule').onclick = () => saveModule().catch(error => toast(error.message))
$('deleteModule').onclick = () => deleteModule().catch(error => toast(error.message))
$('saveModePrices').onclick = () => saveBasePrice().catch(error => toast(error.message))
$('refreshPlatformFiles').onclick = () => loadPlatformFiles().catch(error => toast(error.message))
$('savePlatformFile').onclick = () => savePlatformFile().catch(error => toast(error.message))
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
$('closeSmartPermissionDialog').onclick = closeSmartPermissionDialog
$('closeSmartPermissionDialogBottom').onclick = closeSmartPermissionDialog
$('addSmartPermission').onclick = () => addSmartPermission().catch(error => { $('smartPermissionError').textContent = error.message })
$('saveSmartCommandPrefix').onclick = () => saveSmartCommandPrefix().catch(error => { $('smartPermissionError').textContent = error.message })
$('smartPermissionRole').onchange = () => {
  const admin = $('smartPermissionRole').value === 'admin'
  $('smartPermissionMinutes').disabled = admin
  if (admin) $('smartPermissionMinutes').value = ''
}
$('smartPermissionDialog').onclick = event => { if (event.target === $('smartPermissionDialog')) closeSmartPermissionDialog() }
$('closeBotModuleDialog').onclick = closeBotModuleDialog
$('cancelBotModuleDialog').onclick = closeBotModuleDialog
$('saveBotModules').onclick = () => saveBotModules().catch(error => toast(error.message))
$('botModuleDialog').onclick = event => { if (event.target === $('botModuleDialog')) closeBotModuleDialog() }
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

loadPublicSettings().then(loadMe).catch(error => toast(error.message))
setInterval(() => {
  if (!state.user) return
  if (state.view === 'bots') Promise.all([loadBots(), refreshBalance()]).catch(() => {})
  if (state.view === 'accounts') loadAccounts().catch(() => {})
  if (state.view === 'ledger') loadLedger().catch(() => {})
  if (state.view === 'management' && state.managementTab === 'overview') loadOverview().catch(() => {})
  if (state.view === 'management' && state.managementTab === 'users') loadUsers().catch(() => {})
}, 3000)
