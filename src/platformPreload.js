const Module = require('node:module')
const path = require('node:path')
const { installZenoxChatParser } = require('./zenoxChatParser')
const { isAllowedPlayer, commandTextFor } = require('./botAccess')
const { installClientTickEndPatch } = require('./tickEndPatch')
// 智能 bot 自动欢迎功能（版本号走 smart-runtime/package.json + releases.json 项目规范）。
const { installAutoWelcome } = require('./smartBotAutoWelcome')
// bot 进程的 console 落盘（logs/bot-日期.log）：bot 崩溃/重启后终端回看不
// 到现场，落盘后可按天回查。stdout 原样输出；写失败不影响业务。
// shouldIgnore 丢弃 mineflayer/protodef 的协议调试残留：
//   - TCP 分段的正常现象会被底层库用 "Chunk size ... partial packet"
//     每秒刷几百条，实体密集区一天 40 万条（2026-11-06 实测烧盘 7GB），信息量为零，
//     bot 会自行拼包继续。
//   - PartialReadError（packet_world_particles 读 f32 越界）：1.21.11 的
//     Particle 结构与已装协议定义不完全匹配，每个粒子包都会在 error 事件里
//     打完整堆栈（2026-11-11 实测单分钟 200+ 条），包本身被丢弃不影响业务。
// 在 bot 进程入口整条丢弃，守护进程的转发日志同步干净。
const PROTOCOL_NOISE = /partial packet|Chunk size is \d+ but only \d+ was read|PartialReadError: Read error for undefined/
const CHAT_LOG_MESSAGE_MAX = 2000

// 逐 bot 聊天落盘（logs/chat/<正版名>-日期.log）：服务器发来的全部聊天/
// 系统消息与 bot 自己发出的内容都按时间顺序记录，每 bot 独立文件——排查
// "当时服务器说了什么/bot 说了什么"不再依赖 bot_logs 的截断窗口。
// 文件名用 Minecraft 正版名（bot.username）：UUID 前缀肉眼分不清是哪台 bot。
// 直接在 bot 进程内写文件（不经守护进程转发，避免 IPC 流量翻倍）。
function installChatFileLogger (bot) {
  const CHAT_LOG_MESSAGE_MAX = 2000
  const { loadConfig } = require('./config')
  const fs = require('node:fs')
  const root = loadConfig().root
  // 文件名身份：Minecraft 正版名（登录后即有）；拿不到时回落 botId 前 8 位。
  // 正版名出现前的消息先缓冲（登录横幅等），名字一到位就整批写进正版名文件，
  // 避免同一台 bot 的日志分裂在两个文件里。
  const fallbackId = String(process.env.BOT_PLATFORM_INSTANCE_ID || '').slice(0, 8)
  let botName = ''
  let buffered = []
  // 正版名是否已激活（拿到过一次有效名字）。
  const identityActivated = () => Boolean(botName)
  // 尝试激活：username 出现有效名字时锁定并整批落盘缓冲；返回是否激活成功。
  const activateIdentity = () => {
    const name = String(bot.username || '').trim()
    if (!name || !/^[A-Za-z0-9_]{3,16}$/.test(name)) return false
    botName = name
    if (buffered.length) {
      const pending = buffered
      buffered = []
      for (const line of pending) write(line)
    }
    return true
  }
  const identity = () => {
    if (!identityActivated()) activateIdentity()
    return botName || fallbackId
  }
  const logDir = path.join(root, 'logs', 'chat')
  const maxFileBytes = 256 * 1024 * 1024
  let cappedFile = ''
  const stamp = () => {
    const now = new Date()
    const pad = (value, width = 2) => String(value).padStart(width, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  }
  const fileName = () => {
    const now = new Date()
    const pad = value => String(value).padStart(2, '0')
    return `${identity()}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`
  }
  const write = line => {
    try {
      const name = fileName()
      if (name === cappedFile) return
      fs.mkdirSync(logDir, { recursive: true })
      const file = path.join(logDir, name)
      if (fs.existsSync(file) && fs.statSync(file).size >= maxFileBytes) {
        if (!cappedFile) console.warn(`[chat-log] ${name} 已达上限，本文件停止落盘（新一天自动恢复）。`)
        cappedFile = name
        return
      }
      fs.appendFileSync(file, line + '\n', 'utf8')
    } catch {}
  }
  // 服务器 → bot：全量聊天/系统消息（message 事件带完整组件树，取整行文本）。
  bot.on('message', (message, position) => {
    const text = String(message?.toString?.() || '').trim()
    if (!text) return
    const line = `[${stamp()}] [收] ${text.slice(0, CHAT_LOG_MESSAGE_MAX)}`
    // 正版名尚未激活时先缓冲（登录横幅/MOTD）；identity() 兼做激活器，
    // 名字一出现就把缓冲整批落进正版名文件，避免日志分裂到回落文件名。
    if (!identityActivated() && !activateIdentity()) {
      buffered.push(line)
      if (buffered.length > 200) buffered.shift()
      return
    }
    write(line)
  })
  // bot → 服务器：bot.chat 的外发内容（探测 /baltop、充值 /pay、命令回复等）。
  const originalChat = bot.chat.bind(bot)
  bot.chat = message => {
    const text = String(message || '').trim()
    if (text) write(`[${stamp()}] [发] ${text.slice(0, CHAT_LOG_MESSAGE_MAX)}`)
    return originalChat(message)
  }
  bot.once('end', () => {
    try { bot.chat = originalChat } catch {}
  })
}
if (process.env.BOT_PLATFORM_FILE_LOG !== 'off') {
  try {
    const { loadConfig } = require('./config')
    const { installConsoleFileLogger } = require('./logger')
    installConsoleFileLogger({ logDir: path.join(loadConfig().root, 'logs'), prefix: 'bot', shouldIgnore: text => PROTOCOL_NOISE.test(text) })
  } catch {}
}const originalLoad = Module._load
let patched = false

function send (type, payload = {}) {
  process.send?.({ type, ...payload })
}

const smartRequests = new Map()
const { isMinecraftProfileAuthError } = require('./authCache')
let smartRequestSequence = 0

function smartRequest (action, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('平台进程通信不可用。'))
    const requestId = `${process.pid}-${Date.now()}-${++smartRequestSequence}`
    const timer = setTimeout(() => {
      smartRequests.delete(requestId)
      reject(new Error('平台请求超时。'))
    }, 10000)
    timer.unref()
    smartRequests.set(requestId, { resolve, reject, timer })
    send('smart_request', { requestId, action: String(action || ''), payload })
  })
}

process.on('message', message => {
  if (message?.type !== 'smart_response') return
  const pending = smartRequests.get(String(message.requestId || ''))
  if (!pending) return
  smartRequests.delete(String(message.requestId || ''))
  clearTimeout(pending.timer)
  if (message.ok) pending.resolve(message.result)
  else pending.reject(new Error(String(message.error || '平台请求失败。')))
})

global.botPlatform = Object.freeze({
  success: detail => send('template_success', { detail: String(detail || '').slice(0, 200) }),
  moduleSuccess: (moduleId, detail) => send('module_success', { moduleId: String(moduleId || ''), detail: String(detail || '').slice(0, 200) }),
  log: message => send('log', { message: String(message || '').slice(0, 500) }),
  relatedLog: (message, level = 'audit') => send('related_log', { level: String(level || 'audit').slice(0, 32), message: String(message || '').slice(0, 500) }),
  request: smartRequest
})

global.defineModule = (definition, setup) => ({ definition, setup })

function createModuleHost (bot) {
  const active = new Map()
  let access = { commandPrefix: '!', whitelist: [] }
  try { access = JSON.parse(process.env.BOT_PLATFORM_ACCESS || '{}') } catch {}

  function allowedPlayer (username) {
    return isAllowedPlayer(access, username)
  }

  function unloadAll () {
    for (const cleanup of active.values()) {
      try { cleanup() } catch (error) { console.error(error) }
    }
    active.clear()
  }

  function loadAll (features) {
    unloadAll()
    for (const feature of features || []) {
      const cleanups = []
      try {
        delete require.cache[require.resolve(feature.file)]
        const loaded = require(feature.file)
        const setup = loaded?.setup
        if (typeof setup !== 'function') throw new Error('模块必须使用 defineModule() 导出。')
        const listen = (event, handler) => {
          bot.on(event, handler)
          cleanups.push(() => bot.removeListener(event, handler))
        }
        const api = {
          bot,
          variables: feature.variables || {},
          platform: Object.freeze({ moduleId: feature.id, success: detail => global.botPlatform.moduleSuccess(feature.id, detail) }),
          on: listen,
          message: (options, handler) => {
            const channels = options?.channels || ['public', 'private']
            const pattern = options?.pattern instanceof RegExp ? options.pattern : new RegExp(String(options?.pattern || '.*'))
            listen('botPlatformMessage', event => {
              if (!allowedPlayer(event.username)) return
              pattern.lastIndex = 0
              if (channels.includes(event.channel) && pattern.test(event.message)) {
                send('log', { message: `模块「${feature.name}」匹配消息 · ${event.username}: ${String(event.message || '').slice(0, 240)}` })
                Promise.resolve(handler(event)).catch(console.error)
              }
            })
          },
          command: (options, handler) => {
            const channels = options?.channels || ['public', 'private']
            const pattern = options?.pattern instanceof RegExp ? options.pattern : new RegExp(String(options?.pattern || '.*'))
            listen('botPlatformMessage', event => {
              if (!allowedPlayer(event.username) || !channels.includes(event.channel)) return
              const prefix = String(access.commandPrefix || '!')
              const commandText = commandTextFor(access, event.message)
              if (commandText === null) return
              pattern.lastIndex = 0
              if (!pattern.test(commandText)) return
              send('log', { message: `模块「${feature.name}」匹配命令 · ${event.username}: ${String(event.message || '').slice(0, 240)}` })
              Promise.resolve(handler({ ...event, rawMessage: event.message, message: commandText, prefix })).catch(console.error)
            })
          },
          every: (milliseconds, handler) => {
            const delay = Number(milliseconds)
            if (!Number.isFinite(delay) || delay < 1000) throw new Error('every() 间隔至少为 1000ms。')
            const timer = setInterval(() => Promise.resolve(handler()).catch(console.error), delay)
            cleanups.push(() => clearInterval(timer))
          }
        }
        const returned = setup(api)
        if (typeof returned === 'function') cleanups.push(returned)
        active.set(feature.id, () => cleanups.reverse().forEach(cleanup => cleanup()))
        send('log', { message: `Feature module loaded: ${feature.name}` })
      } catch (error) {
        cleanups.reverse().forEach(cleanup => cleanup())
        send('module_error', { moduleId: feature.id, error: error?.stack || error?.message || String(error) })
      }
    }
  }

  process.on('message', message => {
    if (message?.type === 'reload_modules') {
      loadAll(message.modules || [])
      send('modules_reloaded')
    }
    if (message?.type === 'reload_access') {
      access = message.access || access
      send('access_reloaded')
    }
  })
  return { loadAll, unloadAll }
}

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

    installClientTickEndPatch(bot)
    installResourcePackHandling(bot)
    installZenoxChatParser(bot)
    installAutoWelcome(bot, {
      // 触发即记入该 bot 的"相关日志"（管理页 bot 详情可见，botManager 落库）。
      onTrigger: full => send('related_log', { level: 'audit', message: `自动欢迎触发：系统消息按钮事件检测到 "${full}"，已代发执行。` })
    })
    // 逐 bot 聊天文件日志：服务器来消息全量 + bot 外发都落独立文件。
    if (process.env.BOT_PLATFORM_FILE_LOG !== 'off') {
      try { installChatFileLogger(bot) } catch {}
    }
    bot.on('messagestr', message => {
      const text = String(message || '').trim()
      if (text) send('server_message', { message: text.slice(0, 2000) })
    })
    const moduleHost = createModuleHost(bot)
    let initialModules = []
    try { initialModules = JSON.parse(process.env.BOT_PLATFORM_MODULES || '[]') } catch {}
    moduleHost.loadAll(initialModules)
    bot.once('end', () => moduleHost.unloadAll())

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
      if (!spawned && isMinecraftProfileAuthError(error)) send('profile_auth_failure', { error: detail })
      if (!spawned && isProtocolFailure(error) && !protocolFailureReported) {
        protocolFailureReported = true
        send('protocol_failure', { error: detail })
      }
      send('error', { error: detail })
    })
    bot.on('end', reason => {
      send('state', { state: 'stopped', reason: describe(reason) })
      setImmediate(() => process.exit(0))
    })
    return bot
  }
  return loaded
}

send('state', { state: 'project_started' })
