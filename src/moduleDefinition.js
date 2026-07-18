const vm = require('node:vm')
const { normalizeDefinitions } = require('./templateVariables')

function normalizeBilling (billing) {
  const mode = billing?.mode === 'once' ? 'once' : 'hourly'
  const priceMomoc = Number(billing?.priceMomoc || 0)
  if (!Number.isFinite(priceMomoc) || priceMomoc < 0 || priceMomoc > 1000000000) throw new Error('模块价格无效。')
  return { mode, priceMomoc }
}

function normalizeHelp (help) {
  return (Array.isArray(help) ? help : []).slice(0, 50).map(row => ({
    command: String(row?.command || '').trim().slice(0, 100),
    description: String(row?.description || '').trim().slice(0, 300)
  })).filter(row => row.command || row.description)
}

function parseModuleSource (source) {
  const code = String(source || '')
  if (!code.trim()) throw new Error('功能模块代码不能为空。')
  let captured = null
  const defineModule = (definition, setup) => {
    if (captured) throw new Error('每个文件只能调用一次 defineModule()。')
    if (typeof setup !== 'function') throw new Error('defineModule() 第二个参数必须是初始化函数。')
    captured = { definition, setup }
    return captured
  }
  const sandbox = { module: { exports: {} }, exports: {}, defineModule }
  vm.runInNewContext(code, sandbox, { timeout: 1000 })
  if (!captured) throw new Error('模块必须使用 module.exports = defineModule({...}, setup)。')
  const definition = captured.definition || {}
  const name = String(definition.name || '').trim()
  if (!name) throw new Error('模块定义必须包含 name。')
  return {
    name,
    description: String(definition.description || '').trim(),
    instructions: String(definition.instructions || '').trim(),
    help: normalizeHelp(definition.help),
    variables: normalizeDefinitions(definition.variables || []),
    billing: normalizeBilling(definition.billing),
    source: code
  }
}

module.exports = { parseModuleSource }
