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

function installZenoxChatParser (bot) {
  const seen = new Map()
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
    const clean = String(message || '').trim()
    if (!username || !clean || isSelf(username)) return
    const key = `${String(username).toLowerCase()}|${channel}|${clean}`
    const now = Date.now()
    if (now - (seen.get(key) || 0) < 1500) return
    seen.set(key, now)
    for (const [entry, time] of seen) if (now - time > 10000) seen.delete(entry)
    bot.emit('botPlatformMessage', { username, message: clean, channel, source })
  }
  bot.on('chat', (username, message) => emit(username, message, 'public', 'chat'))
  bot.on('whisper', (username, message) => emit(username, message, 'private', 'whisper'))
  bot.on('messagestr', (message, position, originalMessage, sender) => {
    const privateMessage = parsePrivate(message)
    if (privateMessage) return emit(privateMessage.username, privateMessage.message, 'private', 'messagestr')
    const publicMessage = parsePublic(message, sender)
    if (publicMessage) emit(publicMessage.username, publicMessage.message, 'public', 'messagestr')
  })
  bot._client?.on('player_chat', packet => emit(usernameFromUuid(packet.senderUuid), packet.plainMessage || componentToText(packet.unsignedChatContent), 'public', 'player_chat'))
  bot._client?.on('system_chat', packet => {
    if (packet.isActionBar) return
    const text = componentToText(packet.content)
    const privateMessage = parsePrivate(text)
    if (privateMessage) return emit(privateMessage.username, privateMessage.message, 'private', 'system_chat')
    const publicMessage = parsePublic(text, null)
    if (publicMessage) emit(publicMessage.username, publicMessage.message, 'public', 'system_chat')
  })
}

module.exports = { componentToText, installZenoxChatParser }
