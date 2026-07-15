const fs = require('node:fs')
const path = require('node:path')

const allowedTypes = new Set(['text', 'textarea', 'number', 'boolean', 'select'])

function normalizeDefinitions (input) {
  if (input == null) return []
  if (!Array.isArray(input)) throw new Error('botPlatform.variables 必须是数组。')
  if (input.length > 32) throw new Error('一个模板最多声明 32 个变量。')
  const keys = new Set()
  return input.map((raw, index) => {
    const key = String(raw?.key || '').trim()
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) throw new Error(`第 ${index + 1} 个模板变量 key 无效。`)
    if (keys.has(key)) throw new Error(`模板变量 key 重复：${key}`)
    keys.add(key)
    const type = String(raw?.type || 'text')
    if (!allowedTypes.has(type)) throw new Error(`模板变量 ${key} 的类型不支持。`)
    const label = String(raw?.label || key).trim().slice(0, 64)
    const definition = { key, label, type, required: Boolean(raw?.required) }

    if (type === 'select') {
      if (!Array.isArray(raw.options) || !raw.options.length || raw.options.length > 50) throw new Error(`模板变量 ${key} 必须提供 1-50 个选项。`)
      definition.options = raw.options.map(option => {
        const value = String(typeof option === 'object' ? option.value : option)
        const optionLabel = String(typeof option === 'object' ? (option.label ?? option.value) : option)
        return { value: value.slice(0, 256), label: optionLabel.slice(0, 64) }
      })
    }
    if (type === 'number') {
      if (Number.isFinite(Number(raw.min))) definition.min = Number(raw.min)
      if (Number.isFinite(Number(raw.max))) definition.max = Number(raw.max)
      if (Number.isFinite(Number(raw.step)) && Number(raw.step) > 0) definition.step = Number(raw.step)
    } else if (type !== 'boolean') {
      definition.maxLength = Math.min(4000, Math.max(1, Number.parseInt(raw.maxLength, 10) || 512))
      if (raw.placeholder != null) definition.placeholder = String(raw.placeholder).slice(0, 128)
    }
    if (Object.prototype.hasOwnProperty.call(raw || {}, 'default')) definition.default = normalizeValue(definition, raw.default, false)
    else if (type === 'select') definition.default = definition.options[0].value
    return definition
  })
}

function normalizeValue (definition, input, enforceRequired = true) {
  if (definition.type === 'boolean') return input === true || input === 'true' || input === 1 || input === '1'
  if (definition.type === 'number') {
    if (input === '' || input == null) {
      if (enforceRequired && definition.required) throw new Error(`${definition.label} 不能为空。`)
      return null
    }
    const value = Number(input)
    if (!Number.isFinite(value)) throw new Error(`${definition.label} 必须是数字。`)
    if (definition.min != null && value < definition.min) throw new Error(`${definition.label} 不能小于 ${definition.min}。`)
    if (definition.max != null && value > definition.max) throw new Error(`${definition.label} 不能大于 ${definition.max}。`)
    return value
  }
  const value = String(input ?? '')
  if (enforceRequired && definition.required && !value.trim()) throw new Error(`${definition.label} 不能为空。`)
  if (definition.maxLength && value.length > definition.maxLength) throw new Error(`${definition.label} 最多 ${definition.maxLength} 个字符。`)
  if (definition.type === 'select' && !definition.options.some(option => option.value === value)) throw new Error(`${definition.label} 的选项无效。`)
  return value
}

function validateValues (definitions, input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const allowed = new Set(definitions.map(definition => definition.key))
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new Error(`模板没有声明变量：${key}`)
  }
  const values = {}
  for (const definition of definitions) {
    const raw = Object.prototype.hasOwnProperty.call(source, definition.key) ? source[definition.key] : definition.default
    values[definition.key] = normalizeValue(definition, raw, true)
  }
  if (Buffer.byteLength(JSON.stringify(values), 'utf8') > 16000) throw new Error('模板变量总长度超过限制。')
  return values
}

function readDefinitions (projectPath) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'))
  return normalizeDefinitions(packageJson.botPlatform?.variables)
}

function environmentForValues (values) {
  const env = { BOT_PLATFORM_VARIABLES: JSON.stringify(values || {}) }
  for (const [key, value] of Object.entries(values || {})) {
    env[`BOT_TEMPLATE_${key.toUpperCase()}`] = value == null ? '' : String(value)
  }
  return env
}

module.exports = { environmentForValues, normalizeDefinitions, readDefinitions, validateValues }
