const { recognizePaymentMessage } = require('./paymentRecognizer')

function componentToText (component) {
  if (!component) return ''
  if (typeof component === 'string') {
    try { return componentToText(JSON.parse(component)) } catch { return component }
  }
  if (Array.isArray(component)) return component.map(componentToText).join('')
  if (component.type && Object.prototype.hasOwnProperty.call(component, 'value')) return componentToText(component.value)
  if (typeof component !== 'object') return String(component)
  let text = ''
  if (typeof component.text === 'string') text += component.text
  if (component.text?.value) text += component.text.value
  if (typeof component.translate === 'string') text += component.translate
  if (component.translate?.value) text += component.translate.value
  const extra = component.extra || component.with
  if (Array.isArray(extra)) text += extra.map(componentToText).join('')
  if (extra?.value && Array.isArray(extra.value)) text += extra.value.map(componentToText).join('')
  return text
}

function normalizeServerChatText (message) {
  return String(message || '').replace(/喵[~～]/g, '').trim()
}

function installZenoxChatParser (bot) {
  const seen = new Map()
  const teleportSeen = new Map()
  const peekSeen = new Map()
  const paymentSeen = new Map()
  const teleportRequestPattern = /^\[TSL\]\s*([A-Za-z0-9_]{3,16})\s*\u8bf7\u6c42(?:(\u4f60\u4f20\u9001\u5230\u4ed6\u7684\u4f4d\u7f6e)|(\u4f20\u9001\u5230\u4f60\u7684\u4f4d\u7f6e))\u3002?\s*\(60\s*\u79d2\u5185\u6709\u6548\)\s*\[\u63a5\u53d7\]\s*\[\u62d2\u7edd\]\s*$/
  const peekRequestPattern = /^✨\s*([A-Za-z0-9_]{3,16})\s+想要和你贴贴，输入\s*\/peek accept\s*接受，或\s*\/peek deny\s*拒绝\s*$/
  let paymentRecipient = 'Damomo1'
  let paymentRegexSource = ''
  // 余额不足提示保持原措辞：它触发 top_up_cancel 而不是入账。
  const insufficientBalancePattern = /^\[TSLLLLL\]\s*你的余额少于\s+(50\.00)\s+C\s*$/
  const settingsListener = message => {
    if (message?.type === 'smart_top_up_settings') {
      paymentRecipient = String(message.settings?.recipient || 'Damomo1')
      paymentRegexSource = String(message.settings?.paymentRegex || '')
    }
  }
  const topUpSettingsListener = settings => {
    paymentRecipient = String(settings?.recipient || 'Damomo1')
    paymentRegexSource = String(settings?.paymentRegex || '')
  }
  process.on('message', settingsListener)
  bot.on('botPlatformTopUpSettings', topUpSettingsListener)
  bot.once('end', () => {
    process.removeListener('message', settingsListener)
    bot.removeListener('botPlatformTopUpSettings', topUpSettingsListener)
  })
  const isSelf = username => String(username || '').toLowerCase() === String(bot.username || '').toLowerCase()
  const usernameFromUuid = uuid => {
    const normalized = String(uuid || '').toLowerCase()
    for (const [username, player] of Object.entries(bot.players || {})) {
      if (normalized && String(player?.uuid || '').toLowerCase() === normalized) return username
    }
    return null
  }
  const extractUsername = (text, sender) => {
    const fromUuid = usernameFromUuid(sender)
    if (fromUuid) return fromUuid
    const names = Object.keys(bot.players || {}).filter(name => !isSelf(name)).sort((a, b) => b.length - a.length)
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(text)) return name
    }
    return String(text || '').match(/([A-Za-z0-9_]{3,16})\s*[:：»]?\s*$/)?.[1] || null
  }
  const parsePrivate = message => {
    const text = String(message || '').trim()
    const patterns = [
      /^\[([A-Za-z0-9_]{3,16})\s*[➥➦➤➜→>\-]+\s*([A-Za-z0-9_]{3,16})\]\s*(.+)$/,
      /^\[([A-Za-z0-9_]{3,16})\s*->\s*([A-Za-z0-9_]{3,16})\]\s*(.+)$/,
      /^([A-Za-z0-9_]{3,16})\s+悄悄地对你说[:：]\s*(.+)$/,
      /^([A-Za-z0-9_]{3,16})\s+whispers(?: to you)?[:：]?\s*(.+)$/i
    ]
    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (!match) continue
      if (match.length === 4) {
        if (isSelf(match[1]) || !isSelf(match[2])) return null
        return { username: match[1], message: match[3].trim() }
      }
      if (!isSelf(match[1])) return { username: match[1], message: match[2].trim() }
    }
    return null
  }
  const parsePublic = (message, sender) => {
    const text = String(message || '')
    let divider = Math.max(text.lastIndexOf('>'), text.lastIndexOf('»'))
    if (divider < 0) {
      const indexes = [text.indexOf(':'), text.indexOf('：')].filter(index => index >= 0)
      divider = indexes.length ? Math.min(...indexes) : -1
    }
    const direct = text.trim()
    const body = divider >= 0 ? text.slice(divider + 1).trim() : (/^[!！]/.test(direct) ? direct : '')
    const before = divider >= 0 ? text.slice(0, divider) : ''
    const username = extractUsername(before, sender)
    return body && username && !isSelf(username) ? { username, message: body } : null
  }
  const emit = (username, message, channel, source) => {
    const clean = normalizeServerChatText(message)
    if (!username || !clean || isSelf(username)) return
    const key = `${String(username).toLowerCase()}|${channel}|${clean}`
    const now = Date.now()
    if (now - (seen.get(key) || 0) < 1500) return
    seen.set(key, now)
    for (const [entry, time] of seen) if (now - time > 10000) seen.delete(entry)
    bot.emit('botPlatformMessage', { username, message: clean, channel, source })
  }
  const emitTeleportRequest = (message, source) => {
    const match = String(message || '').trim().match(teleportRequestPattern)
    if (!match || isSelf(match[1])) return false
    const kind = match[2] ? 'to_requester' : 'to_bot'
    const key = `${match[1].toLowerCase()}|${kind}`
    const now = Date.now()
    if (now - (teleportSeen.get(key) || 0) < 1500) return true
    teleportSeen.set(key, now)
    for (const [entry, time] of teleportSeen) if (now - time > 10000) teleportSeen.delete(entry)
    bot.emit('botPlatformTeleportRequest', { username: match[1], kind, source })
    return true
  }
  const emitPeekRequest = (message, source) => {
    const match = String(message || '').trim().match(peekRequestPattern)
    if (!match || isSelf(match[1])) return false
    const key = match[1].toLowerCase()
    const now = Date.now()
    if (now - (peekSeen.get(key) || 0) < 1500) return true
    peekSeen.set(key, now)
    for (const [entry, time] of peekSeen) if (now - time > 10000) peekSeen.delete(entry)
    bot.emit('botPlatformPeekRequest', { username: match[1], source })
    return true
  }
  const emitPaymentMessage = (message, source) => {
    const text = String(message || '').trim()
    // 三层识别（多行正则 → 内置格式 → 启发式）在 paymentRecognizer 里；
    // 这里只传当前收款人和自定义正则，识别不到就当普通消息继续走。
    const payment = recognizePaymentMessage(text, {
      recipient: paymentRecipient,
      paymentRegexSource,
      insufficientBalancePattern
    })
    if (!payment) return false
    const kind = payment.kind
    const amount = payment.amount
    const key = `${kind}|${amount}`
    const now = Date.now()
    if (now - (paymentSeen.get(key) || 0) < 1500) return true
    paymentSeen.set(key, now)
    for (const [entry, time] of paymentSeen) if (now - time > 10000) paymentSeen.delete(entry)
    bot.emit('botPlatformPaymentMessage', { kind, amount, source })
    return true
  }
  bot.on('chat', (username, message) => emit(username, message, 'public', 'chat'))
  bot.on('whisper', (username, message) => emit(username, message, 'private', 'whisper'))
  bot.on('messagestr', (message, position, originalMessage, sender) => {
    if (position === 'system' && emitPaymentMessage(message, 'messagestr')) return
    if (emitPeekRequest(message, 'messagestr')) return
    if (emitTeleportRequest(message, 'messagestr')) return
    const privateMessage = parsePrivate(message)
    if (privateMessage) return emit(privateMessage.username, privateMessage.message, 'private', 'messagestr')
    const publicMessage = parsePublic(message, sender)
    if (publicMessage) emit(publicMessage.username, publicMessage.message, 'public', 'messagestr')
  })
  bot._client?.on('player_chat', packet => emit(usernameFromUuid(packet.senderUuid), packet.plainMessage || componentToText(packet.unsignedChatContent), 'public', 'player_chat'))
  bot._client?.on('system_chat', packet => {
    if (packet.isActionBar) return
    const text = componentToText(packet.content)
    if (emitPaymentMessage(text, 'system_chat')) return
    if (emitPeekRequest(text, 'system_chat')) return
    if (emitTeleportRequest(text, 'system_chat')) return
    const privateMessage = parsePrivate(text)
    if (privateMessage) return emit(privateMessage.username, privateMessage.message, 'private', 'system_chat')
    const publicMessage = parsePublic(text, null)
    if (publicMessage) emit(publicMessage.username, publicMessage.message, 'public', 'system_chat')
  })
}

module.exports = { componentToText, installZenoxChatParser, normalizeServerChatText }
