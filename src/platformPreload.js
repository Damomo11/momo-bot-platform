const Module = require('node:module')
const { installZenoxChatParser } = require('./zenoxChatParser')
const originalLoad = Module._load
let patched = false

function send (type, payload = {}) {
  process.send?.({ type, ...payload })
}

global.botPlatform = Object.freeze({
  success: detail => send('template_success', { detail: String(detail || '').slice(0, 200) })
})

function describe (value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value || '') }
}

function isProtocolFailure (value) {
  return /SlotComponent|array size is abnormally large|Read error.*intArray|play\.toClient|outdated|version|protocol|版本|协议/i.test(describe(value))
}

function installResourcePackHandling (bot) {
  const accepted = new Set()

  function report (phase, packId = '') {
    send('resource_pack', { phase, packId: String(packId || '') })
  }

  function acceptDirect (uuid) {
    const key = String(uuid || '')
    if (!key || accepted.has(key)) return
    accepted.add(key)
    report('accepted', key)

    for (const [phase, result] of [['accepted', 3], ['downloaded', 4], ['loaded', 0]]) {
      try {
        bot._client.write('resource_pack_receive', { uuid, result })
        report(phase, key)
      } catch (error) {
        send('error', { error: `Resource pack ${phase} response failed: ${error.message || error}` })
      }
    }
  }

  bot.on('resourcePack', (url, hashOrUuid) => {
    const key = String(hashOrUuid || url || '')
    report('requested', key)
    if (key && accepted.has(key)) return
    try {
      bot.acceptResourcePack()
      if (key) accepted.add(key)
      report('accepted', key)
    } catch (error) {
      send('error', { error: `Resource pack acceptance failed: ${error.message || error}` })
    }
  })

  bot._client?.on('add_resource_pack', packet => {
    report('requested', packet?.uuid)
    acceptDirect(packet?.uuid)
  })

  bot._client?.on('resource_pack_send', packet => {
    report('requested', packet?.uuid || packet?.hash)
    if (packet?.uuid) acceptDirect(packet.uuid)
  })
}

Module._load = function (request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments)
  if (request !== 'mineflayer' || patched || !loaded?.createBot) return loaded
  patched = true
  const originalCreateBot = loaded.createBot.bind(loaded)

  loaded.createBot = options => {
    const originalCodeHandler = options?.onMsaCode
    const managed = {
      ...(options || {}),
      host: process.env.BOT_PLATFORM_SERVER_HOST,
      port: Number(process.env.BOT_PLATFORM_SERVER_PORT || 25565),
      username: process.env.BOT_PLATFORM_MICROSOFT_EMAIL,
      auth: 'microsoft',
      profilesFolder: process.env.BOT_PLATFORM_PROFILES_FOLDER,
      onMsaCode: code => {
        const oauth = {
          userCode: String(code?.user_code || code?.userCode || ''),
          verificationUri: String(code?.verification_uri || code?.verificationUri || 'https://microsoft.com/link'),
          directUri: String(code?.verification_uri_complete || code?.verificationUriComplete || ''),
          expiresAt: Date.now() + Number(code?.expires_in || code?.expiresIn || 900) * 1000
        }
        send('oauth', { oauth })
        originalCodeHandler?.(code)
      }
    }
    if (process.env.BOT_PLATFORM_MINECRAFT_VERSION) managed.version = process.env.BOT_PLATFORM_MINECRAFT_VERSION
    else delete managed.version

    const bot = originalCreateBot(managed)
    let spawned = false
    let protocolFailureReported = false

    installResourcePackHandling(bot)
    installZenoxChatParser(bot)

    bot._client?.once('session', session => send('state', {
      state: 'authenticated',
      minecraftName: session?.selectedProfile?.name || bot.username || ''
    }))
    bot.once('login', () => send('state', { state: 'logging_in', minecraftName: bot.username }))
    bot.once('spawn', () => {
      spawned = true
      send('state', { state: 'online', minecraftName: bot.username })
    })
    bot.on('kicked', reason => {
      const detail = describe(reason)
      if (!spawned && isProtocolFailure(detail) && !protocolFailureReported) {
        protocolFailureReported = true
        send('protocol_failure', { error: `Kicked before spawn: ${detail}` })
      }
      send('error', { error: `Kicked: ${detail}` })
    })
    bot.on('error', error => {
      const detail = error?.stack || error?.message || String(error)
      if (!spawned && isProtocolFailure(error) && !protocolFailureReported) {
        protocolFailureReported = true
        send('protocol_failure', { error: detail })
      }
      send('error', { error: detail })
    })
    bot.on('end', reason => send('state', { state: 'stopped', reason: describe(reason) }))
    return bot
  }
  return loaded
}

send('state', { state: 'project_started' })
