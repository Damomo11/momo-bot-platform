function isAllowedPlayer (access, username) {
  const whitelist = Array.isArray(access?.whitelist) ? access.whitelist : []
  return whitelist.map(value => String(value).toLowerCase()).includes(String(username || '').toLowerCase())
}

function commandTextFor (access, message) {
  const prefix = String(access?.commandPrefix || '!')
  const text = String(message || '')
  if (!text.startsWith(prefix)) return null
  return text.slice(prefix.length).trim()
}

module.exports = { isAllowedPlayer, commandTextFor }
