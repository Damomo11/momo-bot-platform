const { Vec3 } = require('vec3')
const { version: SMART_BOT_VERSION } = require('./package.json')

const PLAYER_MAP_URL = 'https://map.zenoxs.cn/tiles/settings.json'
const OMINOUS_BOTTLE_INTERVAL_MS = 31 * 60 * 1000
const OMINOUS_BOTTLE_RETRY_MS = 60 * 1000

// All in-game reply text lives here so wording can be changed without touching command logic.
const COMMAND_TEXT = Object.freeze({
  platformUnavailable: '智能 Bot 需要平台请求接口。',
  permissionUsage: command => `正确格式: ${command} 玩家名`,
  permissionRemaining: minutes => `（剩余约 ${minutes} 分钟）`,
  permissionResult: (player, label, exists, remaining) => `玩家 ${player} ${exists ? `在${label}中${remaining}` : `不在${label}中`}`,
  openBoxUsage: '正确格式: 开盒 玩家名',
  openBoxSuccess: (player, position) => `开盒成功！玩家 ${player} 的坐标为 (${position.x},${position.z}) ${position.dimension}`,
  openBoxFailure: '开盒失败！未找到该玩家或地图服务暂时不可用。',
  nearUsage: '正确格式: near [玩家名]',
  nearSuccess: players => players.map(player => `${player.name}(${player.distance})`).join('，'),
  nearEmpty: '附近没有可显示的玩家。',
  nearFailure: player => `near 查询失败！未找到玩家 ${player} 或地图服务暂时不可用。`,
  mountAlready: '机器人已经在载具上。',
  mountMissing: '附近 6 格内没有可乘坐的矿车。',
  mountSuccess: '机器人已上车。',
  mountFailure: '上车失败，请确认矿车可乘坐且距离足够近。',
  dismountMissing: '机器人当前没有乘坐矿车。',
  dismountSuccess: '机器人已下车。',
  dismountFailure: '下车失败，请稍后重试。',
  vaultSuccess: '已右键附近的宝库。',
  vaultMissing: '附近 6 格内没有找到宝库。',
  vaultFailure: '开启宝库失败，请确认宝库在交互距离内。',
  clearEmpty: '机器人背包已经是空的。',
  clearSuccess: (stacks, items) => `背包已清空，共丢出 ${stacks} 组、${items} 个物品。`,
  clearFailure: (stacks, error) => `清空背包中断，已丢出 ${stacks} 组。原因: ${error}`,
  switchUsage: '正确格式: 切换 1-9',
  switchSuccess: slot => `快捷栏已切换到第 ${slot} 格。`,
  ominousUsage: '正确格式: 定时灾厄之瓶 开|关',
  ominousEnabled: '定时灾厄之瓶已开启，将立即饮用一瓶；成功后每 31 分钟执行一次。',
  ominousDisabled: '定时灾厄之瓶已关闭。',
  ominousStatusOn: nextDueAt => `定时灾厄之瓶: 开，下次执行: ${new Date(nextDueAt).toLocaleString('zh-CN')}`,
  ominousStatusOff: '定时灾厄之瓶: 关。',
  periodicRightClickUsage: '正确格式: 定时放置 x y z ngt，例如 定时放置 100 64 200 20。',
  periodicRightClickEnabled: settings => `定时放置已开启: (${settings.periodicRightClickX},${settings.periodicRightClickY},${settings.periodicRightClickZ})，每 ${settings.periodicRightClickIntervalTicks} 游戏刻执行。`,
  periodicRightClickDisabled: '定时放置已关闭。',
  periodicRightClickStatusOff: '定时放置: 关。',
  periodicRightClickStatusOn: settings => `定时放置: 开，坐标 (${settings.periodicRightClickX},${settings.periodicRightClickY},${settings.periodicRightClickZ})，间隔 ${settings.periodicRightClickIntervalTicks} 游戏刻。`,
  rightClickUsage: '正确格式: 右键 玩家名，或 右键 x y z。',
  rightClickSuccess: '右键交互成功。',
  rightClickFailure: '右键交互失败，请确认目标存在且在交互距离内。',
  placeUsage: '正确格式: 放置 x y z。',
  placeSuccess: '放置成功。',
  taskScheduled: (name, ticks) => `定时任务 ${name} 已开启，每 ${ticks} 游戏刻执行一次。`,
  taskStopped: name => `定时任务 ${name} 已关闭。`,
  scheduleStatus: schedules => `定时：${schedules || '无'}`,
  taskUsage: '正确格式: 定时任务 任务名 5；关闭时使用 定时任务 任务名 关。',
  locked: (lock, label = '锁定') => `机器人已被 ${lock.lockedBy || '未知玩家'} ${label}，备注: ${lock.reason || '无'}`,
  lockUsage: '正确格式: 锁定 备注',
  alreadyLocked: '机器人已被锁定，请勿重复锁定。',
  lockSuccess: '锁定成功，由于发消息会取消 afk，请寻找安全地方挂机。',
  notLocked: '机器人没有被锁定。',
  adminUnlockRequired: '机器人处于超级锁定，请由超管使用“超级解锁”。',
  unlockSuccess: '机器人已解锁。',
  forwardUsage: '正确格式: 指令 <服务器指令>',
  forwardInvalid: '指令内容无效或过长。',
  forwardNested: '不能嵌套机器人命令前缀。',
  forwardDangerous: '这条高风险指令已禁用。',
  forwardHomeDisabled: 'home 命令已禁用。',
  restartLocked: '机器人锁定中，请先确认挂机状态并解锁。',
  restarting: '机器人正在重启。',
  permissionAdded: (player, label) => `玩家 ${player} 已成功加入${label}`,
  permissionExists: (player, label) => `玩家 ${player} 已经在${label}中`,
  permissionRemoved: (player, label) => `玩家 ${player} 已从${label}移除`,
  permissionMissing: (player, label) => `玩家 ${player} 不在${label}中`,
  temporaryUsage: command => `正确格式: ${command} 玩家名 分钟数`,
  temporaryAdded: (player, label, minutes) => `玩家 ${player} 已临时加入${label}，持续 ${minutes} 分钟`,
  adminLockUsage: '正确格式: 超级锁定 备注',
  alreadyAdminLocked: '机器人已被超级锁定，请勿重复锁定。',
  adminLockSuccess: '超级锁定成功，禁用一切白名单命令，仅超管可使用“超级解锁”。',
  notAdminLocked: '机器人没有被超级锁定。',
  adminUnlockSuccess: '机器人已超级解锁，普通锁定也已同时解除。'
})

function normalizeCommandPrefixes (prefixes) {
  const unique = new Map()
  for (const value of prefixes || []) {
    const prefix = String(value || '')
    if (!prefix) continue
    unique.set(prefix.toLowerCase(), prefix)
  }
  return [...unique.values()].sort((a, b) => b.length - a.length)
}

function isVersionNewer (candidate, current) {
  const parse = value => {
    const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i)
    return match ? match.slice(1).map(Number) : null
  }
  const next = parse(candidate)
  const installed = parse(current)
  if (!next || !installed) return false
  for (let index = 0; index < 3; index++) {
    if (next[index] !== installed[index]) return next[index] > installed[index]
  }
  return false
}

function parseSmartCommand (message, prefixes = []) {
  const text = String(message || '').replace(/喵[~～]/g, '').trim()
  if (!text) return null
  const lower = text.toLowerCase()
  const prefix = normalizeCommandPrefixes(prefixes).find(value => lower.startsWith(value.toLowerCase()))
  if (!prefix) return null
  const body = text.slice(prefix.length).trimStart()
  if (!body) return null
  const parts = body.split(/\s+/)
  return { prefix, command: parts[0], args: parts.slice(1), body }
}

function parsePeriodicRightClickArgs (args) {
  if (!Array.isArray(args) || args.length !== 4) return null
  const axes = ['x', 'y', 'z']
  const coordinates = {}
  for (let index = 0; index < 3; index++) {
    const match = String(args[index]).match(/^-?\d+$/)
    if (!match) return null
    const value = Number(match[0])
    if (!Number.isInteger(value)) return null
    coordinates[axes[index]] = value
  }
  const intervalTicks = Number(args[3])
  if (!Number.isInteger(intervalTicks) || intervalTicks < 1 || intervalTicks > 1728000) return null
  if ([coordinates.x, coordinates.z].some(value => Math.abs(value) > 30000000) || coordinates.y < -2048 || coordinates.y > 2048) return null
  return { ...coordinates, intervalTicks }
}

function permissionLabel (role) {
  return role === 'whitelist' ? '白名单' : role === 'blacklist' ? '黑名单' : '超管白名单'
}

function remainingText (expiresAt) {
  if (!expiresAt) return ''
  const minutes = Math.max(1, Math.ceil((Number(expiresAt) - Date.now()) / 60000))
  return COMMAND_TEXT.permissionRemaining(minutes)
}

function validateForwardCommand (text, lock, prefixes = [], options = {}) {
  const value = String(text || '').trim()
  if (!value || value.length > 256 || /[\r\n]/.test(value)) return { ok: false, reason: 'invalid' }
  const lower = value.toLowerCase()
  if (normalizeCommandPrefixes(prefixes).some(prefix => !prefix.startsWith('/') && lower.startsWith(prefix.toLowerCase()))) return { ok: false, reason: 'nested' }
  const root = value.split(/\s+/, 1)[0].replace(/^\//, '').toLowerCase()
  if (!options.admin && ['gmp', 'pay', 'msg'].includes(root)) return { ok: false, reason: 'dangerous' }
  if (!options.admin && root.includes('home')) return { ok: false, reason: 'home' }
  if (lock.locked && ['tpa', 'spawn', 'back', 'tpaccept'].includes(root)) return { ok: false, reason: 'locked' }
  return { ok: true, value }
}

function delay (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function waitUntil (predicate, timeoutMilliseconds, intervalMilliseconds = 100) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(intervalMilliseconds)
  }
  return Boolean(predicate())
}

function isMinecartEntity (entity) {
  return /minecart/i.test(`${entity?.name || ''} ${entity?.displayName || ''}`)
}

function hasValidVehicleAttachment (bot, vehicle = bot.vehicle) {
  if (!vehicle) return false
  if (vehicle.id != null && bot.entities && bot.entities[vehicle.id] !== vehicle) return false
  if (Array.isArray(vehicle.passengers) && bot.entity && !vehicle.passengers.includes(bot.entity)) return false
  if (bot.entity?.vehicle && bot.entity.vehicle !== vehicle) return false
  return true
}

function clearStaleVehicleReference (bot) {
  const vehicle = bot.vehicle
  if (!vehicle || hasValidVehicleAttachment(bot, vehicle)) return false
  if (bot.entity?.vehicle === vehicle) bot.entity.vehicle = null
  bot.vehicle = null
  return true
}

async function mountNearestMinecart (bot, maxDistance = 6) {
  const minecart = bot.nearestEntity(isMinecartEntity)
  const distance = minecart && bot.entity?.position?.distanceTo?.(minecart.position)
  if (!minecart || !Number.isFinite(distance) || distance > maxDistance) return { status: 'missing' }
  clearStaleVehicleReference(bot)
  bot.mount(minecart)
  return { status: await waitUntil(() => bot.vehicle === minecart && hasValidVehicleAttachment(bot, minecart), 3000) ? 'mounted' : 'failed' }
}

async function dismountVehicle (bot) {
  clearStaleVehicleReference(bot)
  if (!bot.vehicle) return { status: 'missing' }
  if (typeof bot.dismount === 'function') {
    bot.dismount()
    if (await waitUntil(() => !bot.vehicle, 1500, 50)) return { status: 'dismounted' }
  }
  if (typeof bot.setControlState === 'function') {
    bot.setControlState('sneak', true)
    try {
      return { status: await waitUntil(() => !bot.vehicle, 3000) ? 'dismounted' : 'failed' }
    } finally {
      bot.setControlState('sneak', false)
    }
  }
  if (typeof bot.dismount === 'function') {
    bot.dismount()
    return { status: await waitUntil(() => !bot.vehicle, 3000) ? 'dismounted' : 'failed' }
  }
  return { status: 'failed' }
}

function isVaultBlock (block) {
  return /vault|宝库/i.test(`${block?.name || ''} ${block?.displayName || ''}`)
}

async function activateNearestVault (bot, maxDistance = 6) {
  if (typeof bot.findBlock !== 'function' || typeof bot.activateBlock !== 'function') return { status: 'failed' }
  const vault = bot.findBlock({ matching: isVaultBlock, maxDistance })
  if (!vault) return { status: 'missing' }
  await bot.activateBlock(vault)
  return { status: 'activated', block: vault }
}

async function rightClickTarget (bot, args) {
  if (args.length === 1) {
    const entity = Object.values(bot.entities || {}).filter(row => row?.type === 'player' && String(row.username || '').toLowerCase() === String(args[0]).toLowerCase())[0]
    if (!entity || (typeof bot.activateEntity !== 'function' && typeof bot.activateEntityAt !== 'function')) throw new Error('player missing')
    const distance = bot.entity?.position?.distanceTo?.(entity.position)
    if (!Number.isFinite(distance) || distance > 4.5) throw new Error('player out of reach')
    // Mirror an actual player's ordinary right click: force the server to receive
    // the look direction first, play the hand animation, then use the generic
    // entity-interact packet.  Player-riding mods commonly inspect this sequence.
    if (typeof bot.lookAt === 'function') await bot.lookAt(entity.position.offset(0, 1, 0), true)
    bot.swingArm?.('right')
    if (typeof bot.activateEntity === 'function') await bot.activateEntity(entity)
    else await bot.activateEntityAt(entity, entity.position.offset(0, 1, 0))
    return
  }
  const point = parseCoordinates(args)
  const block = point && bot.blockAt?.(new Vec3(point.x, point.y, point.z))
  if (!block || block.name === 'air' || typeof bot.activateBlock !== 'function') throw new Error('block missing')
  await bot.activateBlock(block)
}

function parseCoordinates (args) {
  if (!Array.isArray(args) || args.length !== 3 || !args.every(value => /^-?\d+$/.test(String(value)))) return null
  const [x, y, z] = args.map(Number)
  if (![x, y, z].every(Number.isInteger) || Math.abs(x) > 30000000 || Math.abs(z) > 30000000 || y < -2048 || y > 2048) return null
  return { x, y, z }
}

function formatScheduleStatus (status = {}) {
  const automation = status.automation || {}
  const entries = []
  if (automation.ominousBottleEnabled) entries.push('灾厄之瓶')
  for (const task of status.tasks || []) entries.push(`定时任务 ${task.name}(${task.intervalTicks}gt)`)
  return entries.join('；') || '无'
}

async function executeCustomTask (bot, task) {
  for (const step of task.steps || []) {
    if (step.type === 'wait') await delay(step.ticks * 50)
    else if (step.type === 'command') {
      const args = step.args || []
      if (step.command === '上车') await mountNearestMinecart(bot)
      else if (step.command === '下车') await dismountVehicle(bot)
      else if (step.command === '清空') await clearInventory(bot)
      else if (step.command === '切换') await bot.setQuickBarSlot(Number(args[0]) - 1)
      else if (step.command === '放置') await placePeriodicRightClick(bot, { periodicRightClickX: Number(args[0]), periodicRightClickY: Number(args[1]), periodicRightClickZ: Number(args[2]) })
      else if (step.command === '右键') await rightClickTarget(bot, args)
      else if (step.command === '指令') bot.chat(args.join(' ').slice(0, 256))
    }
  }
}

async function clearInventory (bot) {
  let stacks = 0
  let items = 0
  while (true) {
    const item = bot.inventory?.items?.()[0]
    if (!item) return { stacks, items }
    if (stacks >= 64) {
      const error = new Error('库存状态长时间未更新，已停止继续丢弃。')
      error.clearedStacks = stacks
      throw error
    }
    try {
      await bot.tossStack(item)
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      error.clearedStacks = stacks
      throw error
    }
    stacks += 1
    items += Number(item.count || 0)
  }
}

function ominousBottleText (item) {
  let nbt = ''
  try { nbt = JSON.stringify(item?.nbt || '') } catch {}
  return `${item?.name || ''} ${item?.displayName || ''} ${item?.customName || ''} ${nbt}`
}

function isOminousBottleItem (item) {
  return /ominous_bottle|灾厄之瓶|灾厄药水|不祥之瓶/i.test(ominousBottleText(item))
}

function countOminousBottles (bot) {
  return (bot.inventory?.items?.() || []).filter(isOminousBottleItem).reduce((sum, item) => sum + Number(item.count || 0), 0)
}

async function drinkOminousBottle (bot) {
  if (!bot.entity || !bot.inventory) throw new Error('机器人尚未进入服务器。')
  const item = bot.inventory.items().find(isOminousBottleItem)
  if (!item) throw new Error('背包中没有灾厄之瓶。')
  const before = countOminousBottles(bot)
  await bot.equip(item, 'hand')
  if (item.name === 'ominous_bottle') {
    bot.activateItem()
    try { await delay(2200) } finally { bot.deactivateItem() }
  } else {
    await bot.consume()
  }
  const consumed = await waitUntil(() => countOminousBottles(bot) < before, 5000, 250)
  if (!consumed) throw new Error('服务器未确认灾厄之瓶已被饮用。')
  return { consumed: true }
}

function createBotActionQueue () {
  let tail = Promise.resolve()
  return task => {
    const running = tail.catch(() => {}).then(task)
    tail = running
    return running
  }
}

function createOminousBottleScheduler (bot, options = {}) {
  const platform = options.platform || global.botPlatform
  const runBotAction = options.runBotAction || (task => task())
  const retryMilliseconds = Number(options.retryMilliseconds || OMINOUS_BOTTLE_RETRY_MS)
  const drink = options.drinkOminousBottle || drinkOminousBottle
  const now = options.now || Date.now
  const setTimer = options.setTimer || setTimeout
  const clearTimer = options.clearTimer || clearTimeout
  const logger = options.logger || console
  let settings = { ominousBottleEnabled: false, ominousBottleNextDueAt: null }
  let timer = null
  let stopped = false

  function cancelTimer () {
    if (timer) clearTimer(timer)
    timer = null
  }

  function arm (delayOverride) {
    cancelTimer()
    if (stopped || !settings.ominousBottleEnabled) return
    const dueDelay = Number(settings.ominousBottleNextDueAt || now()) - now()
    const wait = Math.max(0, Number(delayOverride ?? dueDelay))
    timer = setTimer(run, Math.min(wait, 2147483647))
    timer?.unref?.()
  }

  async function run () {
    timer = null
    if (stopped || !settings.ominousBottleEnabled) return
    try {
      await runBotAction(() => drink(bot))
      settings = await platform.request('ominous_schedule_complete', {})
      logger.log?.('[smart-ominous] 已饮用灾厄之瓶，下次将在 31 分钟后执行。')
      arm()
    } catch (error) {
      logger.warn?.(`[smart-ominous] ${error?.message || error} 将在 1 分钟后重试。`)
      arm(retryMilliseconds)
    }
  }

  function applySettings (next) {
    settings = { ...settings, ...(next || {}) }
    arm()
    return settings
  }

  async function start () {
    applySettings(await platform.request('ominous_schedule_get', {}))
  }

  function stop () {
    stopped = true
    cancelTimer()
  }

  return { applySettings, start, stop, runNow: run, getSettings: () => ({ ...settings }) }
}

const PERIODIC_RIGHT_CLICK_FACES = Object.freeze({
  'x+': new Vec3(1, 0, 0),
  'x-': new Vec3(-1, 0, 0),
  'y+': new Vec3(0, 1, 0),
  'y-': new Vec3(0, -1, 0),
  'z+': new Vec3(0, 0, 1),
  'z-': new Vec3(0, 0, -1)
})

function usablePlacementReference (block) {
  return Boolean(block && block.name !== 'air' && block.boundingBox !== 'empty')
}

async function placePeriodicRightClick (bot, settings) {
  if (!bot.entity || typeof bot.blockAt !== 'function' || typeof bot.placeBlock !== 'function') throw new Error('机器人尚未进入服务器。')
  if (!bot.heldItem) throw new Error('机器人主手没有可放置物品。')
  const position = new Vec3(Number(settings.periodicRightClickX), Number(settings.periodicRightClickY), Number(settings.periodicRightClickZ))
  const candidates = [
    { offset: new Vec3(0, -1, 0), face: PERIODIC_RIGHT_CLICK_FACES['y+'] },
    { offset: new Vec3(0, 1, 0), face: PERIODIC_RIGHT_CLICK_FACES['y-'] },
    { offset: new Vec3(-1, 0, 0), face: PERIODIC_RIGHT_CLICK_FACES['x+'] },
    { offset: new Vec3(1, 0, 0), face: PERIODIC_RIGHT_CLICK_FACES['x-'] },
    { offset: new Vec3(0, 0, -1), face: PERIODIC_RIGHT_CLICK_FACES['z+'] },
    { offset: new Vec3(0, 0, 1), face: PERIODIC_RIGHT_CLICK_FACES['z-'] }
  ]
  const selected = candidates.map(candidate => ({ ...candidate, block: bot.blockAt(position.plus(candidate.offset)) })).find(candidate => usablePlacementReference(candidate.block))
  if (!selected) throw new Error('目标位置周围没有可用于放置的方块。')
  await bot.placeBlock(selected.block, selected.face)
  return { placed: true }
}

function createPeriodicRightClickScheduler (bot, options = {}) {
  const platform = options.platform || global.botPlatform
  const runBotAction = options.runBotAction || (task => task())
  const place = options.placePeriodicRightClick || placePeriodicRightClick
  const now = options.now || Date.now
  const setTimer = options.setTimer || setTimeout
  const clearTimer = options.clearTimer || clearTimeout
  const logger = options.logger || console
  let settings = { periodicRightClickEnabled: false, periodicRightClickNextDueAt: null, periodicRightClickIntervalTicks: 20 }
  let timer = null
  let stopped = false
  let lastWarning = ''
  let lastWarningAt = 0

  function warn (message) {
    const text = String(message || '')
    const current = now()
    if (text === lastWarning && current - lastWarningAt < 60000) return
    lastWarning = text
    lastWarningAt = current
    logger.warn?.(`[smart-periodic-right-click] ${text}`)
  }

  function cancelTimer () {
    if (timer) clearTimer(timer)
    timer = null
  }

  function arm () {
    cancelTimer()
    if (stopped || !settings.periodicRightClickEnabled) return
    const wait = Math.max(0, Number(settings.periodicRightClickNextDueAt || now()) - now())
    timer = setTimer(run, Math.min(wait, 2147483647))
    timer?.unref?.()
  }

  async function run () {
    timer = null
    if (stopped || !settings.periodicRightClickEnabled) return
    try {
      await runBotAction(() => place(bot, settings))
    } catch (error) {
      warn(error?.message || error)
    }
    try {
      settings = await platform.request('periodic_right_click_complete', {})
    } catch (error) {
      settings = { ...settings, periodicRightClickNextDueAt: now() + Number(settings.periodicRightClickIntervalTicks || 20) * 50 }
      warn(`无法保存下次执行时间: ${error?.message || error}`)
    }
    arm()
  }

  function applySettings (next) {
    settings = { ...settings, ...(next || {}) }
    arm()
    return settings
  }

  async function start () {
    applySettings(await platform.request('periodic_right_click_get', {}))
  }

  function stop () {
    stopped = true
    cancelTimer()
  }

  return { applySettings, start, stop, runNow: run, getSettings: () => ({ ...settings }) }
}

function mapDimensionLabel (world, worldSettings = []) {
  const value = String(world || '').toLowerCase()
  if (value === 'world' || value === 'overworld') return '主世界'
  if (value.includes('nether')) return '地狱'
  if (value.includes('the_end') || value === 'end') return '末地'
  const configured = worldSettings.find(entry => String(entry?.name || '').toLowerCase() === value)
  return String(configured?.displayName || world || '未知维度')
}

function normalizeMapPlayer (row, worldSettings = []) {
  const name = String(row?.name || '').trim()
  const x = Number(row?.position?.x)
  const z = Number(row?.position?.z)
  const rawY = row?.position?.y
  const y = rawY == null ? null : Number(rawY)
  const world = String(row?.world || 'world').trim() || 'world'
  if (!name || ![x, z].every(Number.isFinite) || (y !== null && !Number.isFinite(y))) return null
  return {
    name,
    x,
    y,
    z,
    world,
    dimension: mapDimensionLabel(world, worldSettings)
  }
}

function createPlayerMapClient (fetchImpl, options = {}) {
  const cacheMilliseconds = Number(options.cacheMilliseconds ?? 3000)
  let cachedPlayers = null
  let cacheExpiresAt = 0
  let loading = null

  async function fetchPlayers () {
    if (cachedPlayers && Date.now() < cacheExpiresAt) return cachedPlayers
    if (loading) return loading
    loading = (async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      timeout.unref?.()
      try {
        const response = await fetchImpl(PLAYER_MAP_URL, {
          signal: controller.signal,
          headers: { accept: 'application/json', referer: 'https://map.zenoxs.cn/' }
        })
        if (!response?.ok) throw new Error(`HTTP ${response?.status || 'unknown'}`)
        const data = await response.json()
        const worldSettings = Array.isArray(data?.worldSettings) ? data.worldSettings : []
        cachedPlayers = (Array.isArray(data?.players) ? data.players : []).map(row => normalizeMapPlayer(row, worldSettings)).filter(Boolean)
        cacheExpiresAt = Date.now() + Math.max(0, cacheMilliseconds)
        return cachedPlayers
      } finally {
        clearTimeout(timeout)
        loading = null
      }
    })()
    return loading
  }

  async function findPlayer (name) {
    const players = await fetchPlayers()
    return players.find(player => player.name.toLowerCase() === String(name).toLowerCase()) || null
  }

  async function nearestPlayers (centerName, limit = 3) {
    const players = await fetchPlayers()
    const center = players.find(player => player.name.toLowerCase() === String(centerName).toLowerCase())
    if (!center) return null
    return players
      .filter(player => player.world.toLowerCase() === center.world.toLowerCase() && player.name.toLowerCase() !== center.name.toLowerCase())
      .map(player => ({
        name: player.name,
        distance: Math.round(Math.hypot(
          player.x - center.x,
          player.z - center.z,
          ...(player.y !== null && center.y !== null ? [player.y - center.y] : [])
        ))
      }))
      .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
      .slice(0, limit)
  }

  return { fetchPlayers, findPlayer, nearestPlayers }
}

async function findPlayerPosition (name, source) {
  const mapClient = typeof source === 'function' ? createPlayerMapClient(source) : source
  const player = await mapClient.findPlayer(name)
  if (!player) throw new Error('player not found')
  return { x: Math.trunc(player.x), z: Math.trunc(player.z), world: player.world, dimension: player.dimension }
}

function createSmartCommandHandler (bot, options = {}) {
  const platform = options.platform || global.botPlatform
  const fetchImpl = options.fetchImpl || global.fetch
  const mapClient = options.mapClient || createPlayerMapClient(fetchImpl, options.mapOptions)
  const getCommandPrefixes = options.getCommandPrefixes || (() => options.commandPrefixes || [bot.username])
  const runBotAction = options.runBotAction || (task => task())
  const applyOminousSettings = options.applyOminousSettings || (() => {})
  const applyPeriodicRightClickSettings = options.applyPeriodicRightClickSettings || (() => {})
  const scheduleRestart = options.scheduleRestart || (callback => {
    const timer = setTimeout(callback, 600)
    timer.unref?.()
  })
  const versionNotifiedPlayers = options.versionNotifiedPlayers || new Set()

  if (!platform?.request) throw new Error(COMMAND_TEXT.platformUnavailable)

  const replyText = (message, key, variables = {}) => {
    const overrides = options.getMessageOverrides?.() || {}
    let value = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : message
    return String(value ?? '').replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match)
  }
  const reply = (message, key, variables = {}) => {
    const value = replyText(message, key, variables)
    if (value !== '') bot.chat(value.slice(0, 256))
    return value
  }
  const request = (action, payload) => platform.request(action, payload)
  const notifyNewVersion = async username => {
    const key = String(username || '').toLowerCase()
    if (versionNotifiedPlayers.has(key) || !/^[A-Za-z0-9_]{3,16}$/.test(String(username || ''))) return
    try {
      const latest = await request('runtime_version', {})
      if (!isVersionNewer(latest?.version, SMART_BOT_VERSION)) return
      bot.chat(`/msg ${username} bot已有新版本，重启后自动更新新版本。`)
      versionNotifiedPlayers.add(key)
    } catch (error) {
      platform.log?.(`检查智能 Bot 版本失败: ${error?.message || error}`)
    }
  }

  return async event => {
    if (!event?.username || String(event.username).toLowerCase() === String(bot.username || '').toLowerCase()) return
    const prefixes = getCommandPrefixes()
    const parsed = parseSmartCommand(event.message, prefixes)
    if (!parsed) return

    if (parsed.command === '版本') {
      bot.chat(`智能 Bot 版本：v${SMART_BOT_VERSION}`)
      return
    }

    const username = String(event.username).replace(/^#/, '')
    platform.log?.(`命令匹配 · ${username}: ${String(event.message || '').slice(0, 240)}`)
    const access = await request('access', { username })
    if (access.blacklisted) return
    await notifyNewVersion(username)

    if (parsed.command === '查白' || parsed.command === '查黑' || parsed.command === '查超管') {
      if (parsed.args.length !== 1) return reply(COMMAND_TEXT.permissionUsage(parsed.command), 'permissionUsage', { command: parsed.command })
      const role = parsed.command === '查白' ? 'whitelist' : parsed.command === '查黑' ? 'blacklist' : 'admin'
      const result = await request('permission_query', { username, target: parsed.args[0], role })
      if (!result.allowed) return
      const remaining = remainingText(result.permission?.expiresAt)
      reply(COMMAND_TEXT.permissionResult(parsed.args[0], permissionLabel(role), result.exists, remaining), 'permissionResult', { player: parsed.args[0], label: permissionLabel(role), status: result.exists ? '在' : '不在', remaining })
      return
    }

    if (parsed.command === '开盒' || parsed.command === '开户') {
      if (parsed.args.length !== 1) return reply(COMMAND_TEXT.openBoxUsage, 'openBoxUsage')
      try {
        const position = await findPlayerPosition(parsed.args[0], mapClient)
        reply(COMMAND_TEXT.openBoxSuccess(parsed.args[0], position), 'openBoxSuccess', { player: parsed.args[0], x: position.x, z: position.z, dimension: position.dimension })
      } catch {
        reply(COMMAND_TEXT.openBoxFailure, 'openBoxFailure')
      }
      return
    }

    if (parsed.command.toLowerCase() === 'near') {
      if (parsed.args.length > 1) return reply(COMMAND_TEXT.nearUsage, 'nearUsage')
      const centerName = parsed.args[0] || username
      try {
        const nearest = await mapClient.nearestPlayers(centerName, 3)
        if (!nearest) return reply(COMMAND_TEXT.nearFailure(centerName), 'nearFailure', { player: centerName })
        const players = COMMAND_TEXT.nearSuccess(nearest)
        reply(nearest.length ? players : COMMAND_TEXT.nearEmpty, nearest.length ? 'nearSuccess' : 'nearEmpty', { players })
      } catch {
        reply(COMMAND_TEXT.nearFailure(centerName), 'nearFailure', { player: centerName })
      }
      return
    }

    if (access.lock.adminLocked && !access.admin && parsed.command !== '状态') return reply(COMMAND_TEXT.locked(access.lock, '超级锁定'), 'locked', { player: access.lock.lockedBy || '未知玩家', label: '超级锁定', reason: access.lock.reason || '无' })
    if (!access.whitelisted) return

    if (parsed.command === '上车') {
      if (parsed.args.length) return reply(COMMAND_TEXT.mountFailure, 'mountFailure')
      try {
        const result = await runBotAction(() => mountNearestMinecart(bot))
        if (result.status === 'missing') reply(COMMAND_TEXT.mountMissing, 'mountMissing')
        else if (result.status === 'failed') reply(COMMAND_TEXT.mountFailure, 'mountFailure')
        else reply(COMMAND_TEXT.mountSuccess, 'mountSuccess')
      } catch {
        reply(COMMAND_TEXT.mountFailure, 'mountFailure')
      }
      return
    }

    if (parsed.command === '下车') {
      if (parsed.args.length) return reply(COMMAND_TEXT.dismountFailure, 'dismountFailure')
      try {
        const result = await runBotAction(() => dismountVehicle(bot))
        if (result.status === 'missing') reply(COMMAND_TEXT.dismountMissing, 'dismountMissing')
        else if (result.status === 'failed') reply(COMMAND_TEXT.dismountFailure, 'dismountFailure')
        else reply(COMMAND_TEXT.dismountSuccess, 'dismountSuccess')
      } catch {
        reply(COMMAND_TEXT.dismountFailure, 'dismountFailure')
      }
      return
    }

    if (parsed.command === '开宝库') {
      if (parsed.args.length) return reply(COMMAND_TEXT.vaultFailure, 'vaultFailure')
      try {
        const result = await runBotAction(() => activateNearestVault(bot))
        if (result.status === 'missing') reply(COMMAND_TEXT.vaultMissing, 'vaultMissing')
        else if (result.status === 'failed') reply(COMMAND_TEXT.vaultFailure, 'vaultFailure')
        else reply(COMMAND_TEXT.vaultSuccess, 'vaultSuccess')
      } catch {
        reply(COMMAND_TEXT.vaultFailure, 'vaultFailure')
      }
      return
    }

    if (parsed.command === '清空') {
      if (parsed.args.length) return
      let completedStacks = 0
      try {
        const result = await runBotAction(async () => {
          const cleared = await clearInventory(bot)
          completedStacks = cleared.stacks
          return cleared
        })
        reply(result.stacks ? COMMAND_TEXT.clearSuccess(result.stacks, result.items) : COMMAND_TEXT.clearEmpty, result.stacks ? 'clearSuccess' : 'clearEmpty', { stacks: result.stacks, items: result.items })
      } catch (error) {
        const stacks = Number(error?.clearedStacks ?? completedStacks); const reason = error?.message || '未知错误'
        reply(COMMAND_TEXT.clearFailure(stacks, reason), 'clearFailure', { stacks, reason })
      }
      return
    }

    if (parsed.command === '切换') {
      const slot = Number(parsed.args[0])
      if (parsed.args.length !== 1 || !Number.isInteger(slot) || slot < 1 || slot > 9) return reply(COMMAND_TEXT.switchUsage, 'switchUsage')
      await runBotAction(() => bot.setQuickBarSlot(slot - 1))
      reply(COMMAND_TEXT.switchSuccess(slot), 'switchSuccess', { slot })
      return
    }

    if (parsed.command === '定时灾厄之瓶') {
      if (!parsed.args.length) {
        const settings = await request('ominous_schedule_get', {})
        const nextTime = settings.ominousBottleNextDueAt ? new Date(settings.ominousBottleNextDueAt).toLocaleString('zh-CN') : ''
        reply(settings.ominousBottleEnabled ? COMMAND_TEXT.ominousStatusOn(settings.ominousBottleNextDueAt) : COMMAND_TEXT.ominousStatusOff, settings.ominousBottleEnabled ? 'ominousStatusOn' : 'ominousStatusOff', { nextTime })
        return
      }
      if (parsed.args.length !== 1 || !['开', '关'].includes(parsed.args[0])) return reply(COMMAND_TEXT.ominousUsage, 'ominousUsage')
      const result = await request('ominous_schedule_set', { username, enabled: parsed.args[0] === '开' })
      if (!result.allowed) return
      applyOminousSettings(result.settings)
      reply(result.settings.ominousBottleEnabled ? COMMAND_TEXT.ominousEnabled : COMMAND_TEXT.ominousDisabled, result.settings.ominousBottleEnabled ? 'ominousEnabled' : 'ominousDisabled')
      return
    }

    if (parsed.command === '放置') {
      const point = parseCoordinates(parsed.args)
      if (!point) return reply(COMMAND_TEXT.placeUsage, 'placeUsage')
      try {
        await runBotAction(() => placePeriodicRightClick(bot, { periodicRightClickX: point.x, periodicRightClickY: point.y, periodicRightClickZ: point.z }))
        reply(COMMAND_TEXT.placeSuccess, 'placeSuccess')
      } catch (error) { const reason = error?.message || '未知错误'; reply(reason, 'placeFailure', { reason }) }
      return
    }

    if (parsed.command === '右键') {
      if (!(parsed.args.length === 1 || parseCoordinates(parsed.args))) return reply(COMMAND_TEXT.rightClickUsage, 'rightClickUsage')
      try { await runBotAction(() => rightClickTarget(bot, parsed.args)); reply(COMMAND_TEXT.rightClickSuccess, 'rightClickSuccess') } catch { reply(COMMAND_TEXT.rightClickFailure, 'rightClickFailure') }
      return
    }

    if (parsed.command === '定时任务') {
      if (parsed.args.length === 2 && parsed.args[1] === '关') {
        const result = await request('task_schedule_set', { username, name: parsed.args[0], intervalTicks: null })
        if (result.allowed) reply(COMMAND_TEXT.taskStopped(parsed.args[0]), 'taskStopped', { task: parsed.args[0] })
        return
      }
      const ticks = Number(String(parsed.args[1] || '').replace(/gt$/i, ''))
      if (parsed.args.length !== 2 || !Number.isInteger(ticks) || ticks < 1) return reply(COMMAND_TEXT.taskUsage, 'taskUsage')
      const result = await request('task_schedule_set', { username, name: parsed.args[0], intervalTicks: ticks })
      if (result.allowed) reply(COMMAND_TEXT.taskScheduled(parsed.args[0], ticks), 'taskScheduled', { task: parsed.args[0], ticks })
      return
    }

    if (parsed.command === '锁定') {
      if (!parsed.args.length) return reply(COMMAND_TEXT.lockUsage, 'lockUsage')
      const result = await request('lock_set', { username, level: 'normal', locked: true, reason: parsed.args.join(' ') })
      if (!result.allowed) return
      if (result.status === 'exists') reply(COMMAND_TEXT.alreadyLocked, 'alreadyLocked')
      else if (result.status === 'admin_locked') reply(COMMAND_TEXT.locked(result.lock, '超级锁定'), 'locked', { player: result.lock.lockedBy || '未知玩家', label: '超级锁定', reason: result.lock.reason || '无' })
      else reply(COMMAND_TEXT.lockSuccess, 'lockSuccess')
      return
    }

    if (parsed.command === '解锁') {
      const result = await request('lock_set', { username, level: 'normal', locked: false })
      if (!result.allowed) return
      if (result.status === 'missing') reply(COMMAND_TEXT.notLocked, 'notLocked')
      else if (result.status === 'admin_locked') reply(COMMAND_TEXT.adminUnlockRequired, 'adminUnlockRequired')
      else reply(COMMAND_TEXT.unlockSuccess, 'unlockSuccess')
      return
    }

    if (parsed.command === '状态') {
      const lockVariables = { player: access.lock.lockedBy || '未知玩家', label: access.lock.adminLocked ? '超级锁定' : '锁定', reason: access.lock.reason || '无' }
      const lockText = access.lock.adminLocked
        ? replyText(COMMAND_TEXT.locked(access.lock, '超级锁定'), 'locked', lockVariables)
        : access.lock.locked
            ? replyText(COMMAND_TEXT.locked(access.lock), 'locked', lockVariables)
            : replyText(COMMAND_TEXT.notLocked, 'notLocked')
      let schedules = '暂时无法读取'
      try {
        schedules = formatScheduleStatus(await request('schedule_status', {}))
      } catch (error) {
        platform.log?.(`读取定时状态失败: ${error?.message || error}`)
      }
      const scheduleText = replyText(COMMAND_TEXT.scheduleStatus(schedules), 'scheduleStatus', { schedules })
      const response = [lockText, scheduleText].filter(Boolean).join('；')
      if (response) bot.chat(response.slice(0, 256))
      return
    }

    if (parsed.command === '指令') {
      if (!parsed.args.length) return reply(COMMAND_TEXT.forwardUsage, 'forwardUsage')
      const checked = validateForwardCommand(parsed.args.join(' '), access.lock, prefixes, { admin: access.admin })
      const forwardErrors = {
        invalid: COMMAND_TEXT.forwardInvalid,
        nested: COMMAND_TEXT.forwardNested,
        dangerous: COMMAND_TEXT.forwardDangerous,
        home: COMMAND_TEXT.forwardHomeDisabled,
        locked: COMMAND_TEXT.locked(access.lock)
      }
      if (checked.ok) reply(checked.value)
      else reply(forwardErrors[checked.reason], checked.reason === 'locked' ? 'locked' : `forward${checked.reason[0].toUpperCase()}${checked.reason.slice(1)}`, { player: access.lock.lockedBy || '未知玩家', label: '锁定', reason: access.lock.reason || '无' })
      return
    }

    const builtInAdminCommands = new Set(['重启', '加白', '加黑', '加超管', '去白', '去黑', '去超管', '临时加白', '临时加黑', '超级锁定', '超级解锁'])
    if (!access.admin || !builtInAdminCommands.has(parsed.command)) {
      const customTask = await request('task_get', { name: parsed.command })
      if (customTask?.task) {
        await runBotAction(() => executeCustomTask(bot, customTask.task))
        return
      }
    }

    if (!access.admin) return

    if (parsed.command === '重启') {
      if (access.lock.locked) return reply(COMMAND_TEXT.restartLocked, 'restartLocked')
      reply(COMMAND_TEXT.restarting, 'restarting')
      scheduleRestart(() => process.exit(0))
      return
    }

    const addRoles = { 加白: 'whitelist', 加黑: 'blacklist', 加超管: 'admin' }
    const removeRoles = { 去白: 'whitelist', 去黑: 'blacklist', 去超管: 'admin' }
    if (addRoles[parsed.command] || removeRoles[parsed.command]) {
      if (parsed.args.length !== 1) return reply(COMMAND_TEXT.permissionUsage(parsed.command), 'permissionUsage', { command: parsed.command })
      const adding = Boolean(addRoles[parsed.command])
      const role = addRoles[parsed.command] || removeRoles[parsed.command]
      const result = await request(adding ? 'permission_add' : 'permission_remove', { username, target: parsed.args[0], role })
      if (!result.allowed) return
      const label = permissionLabel(role)
      if (adding) reply(result.added ? COMMAND_TEXT.permissionAdded(parsed.args[0], label) : COMMAND_TEXT.permissionExists(parsed.args[0], label), result.added ? 'permissionAdded' : 'permissionExists', { player: parsed.args[0], label })
      else reply(result.removed ? COMMAND_TEXT.permissionRemoved(parsed.args[0], label) : COMMAND_TEXT.permissionMissing(parsed.args[0], label), result.removed ? 'permissionRemoved' : 'permissionMissing', { player: parsed.args[0], label })
      return
    }

    if (parsed.command === '临时加白' || parsed.command === '临时加黑') {
      const minutes = Number(parsed.args[1])
      if (parsed.args.length !== 2 || !Number.isInteger(minutes) || minutes < 1) return reply(COMMAND_TEXT.temporaryUsage(parsed.command), 'temporaryUsage', { command: parsed.command })
      const role = parsed.command === '临时加白' ? 'whitelist' : 'blacklist'
      const result = await request('permission_add', { username, target: parsed.args[0], role, minutes })
      if (!result.allowed) return
      reply(COMMAND_TEXT.temporaryAdded(parsed.args[0], permissionLabel(role), minutes), 'temporaryAdded', { player: parsed.args[0], label: permissionLabel(role), minutes })
      return
    }

    if (parsed.command === '超级锁定') {
      if (!parsed.args.length) return reply(COMMAND_TEXT.adminLockUsage, 'adminLockUsage')
      const result = await request('lock_set', { username, level: 'admin', locked: true, reason: parsed.args.join(' ') })
      if (!result.allowed) return
      reply(result.status === 'exists' ? COMMAND_TEXT.alreadyAdminLocked : COMMAND_TEXT.adminLockSuccess, result.status === 'exists' ? 'alreadyAdminLocked' : 'adminLockSuccess')
      return
    }

    if (parsed.command === '超级解锁') {
      const result = await request('lock_set', { username, level: 'admin', locked: false })
      if (!result.allowed) return
      reply(result.status === 'missing' ? COMMAND_TEXT.notAdminLocked : COMMAND_TEXT.adminUnlockSuccess, result.status === 'missing' ? 'notAdminLocked' : 'adminUnlockSuccess')
    }
  }
}

function createTeleportRequestHandler (bot, options = {}) {
  const platform = options.platform || global.botPlatform
  const runBotAction = options.runBotAction || (task => task())

  if (!platform?.request) throw new Error(COMMAND_TEXT.platformUnavailable)

  return async event => {
    const username = String(event?.username || '').replace(/^#/, '')
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username) || username.toLowerCase() === String(bot.username || '').toLowerCase()) return

    const access = await platform.request('access', { username })
    if (access.blacklisted || !access.whitelisted || (access.lock?.locked && event?.kind !== 'to_bot')) return
    await runBotAction(() => bot.chat(`/tpaccept ${username}`))
  }
}

function installSmartCommands (bot, options = {}) {
  const platform = options.platform || global.botPlatform
  const runBotAction = options.runBotAction || createBotActionQueue()
  const ominousScheduler = options.ominousScheduler || createOminousBottleScheduler(bot, { ...options, platform, runBotAction })
  const periodicRightClickScheduler = options.periodicRightClickScheduler || createPeriodicRightClickScheduler(bot, { ...options, platform, runBotAction })
  let commandPrefix = String(options.commandPrefix ?? '')
  let messageOverrides = {}
  const settingsListener = message => {
    if (message?.type === 'smart_settings') {
      commandPrefix = String(message.settings?.commandPrefix || '')
      messageOverrides = message.settings?.messageOverrides || {}
    }
    if (message?.type === 'smart_automation') {
      ominousScheduler.applySettings(message.automation || {})
      periodicRightClickScheduler.applySettings(message.automation || {})
    }
  }
  process.on('message', settingsListener)
  platform?.request?.('settings', {}).then(settings => {
    commandPrefix = String(settings?.commandPrefix || '')
    messageOverrides = settings?.messageOverrides || {}
  }).catch(error => console.error('[smart-settings]', error?.stack || error))

  const handle = createSmartCommandHandler(bot, {
    ...options,
    platform,
    runBotAction,
    applyOminousSettings: settings => ominousScheduler.applySettings(settings),
    applyPeriodicRightClickSettings: settings => periodicRightClickScheduler.applySettings(settings),
    getCommandPrefixes: () => [commandPrefix, bot.username],
    getMessageOverrides: () => messageOverrides
  })
  const handleTeleportRequest = createTeleportRequestHandler(bot, { ...options, platform, runBotAction })
  const playerQueues = new Map()
  const listener = event => {
    const key = String(event?.username || '').toLowerCase()
    const previous = playerQueues.get(key) || Promise.resolve()
    const next = previous.catch(() => {}).then(() => handle(event))
    playerQueues.set(key, next)
    next.catch(error => console.error('[smart-command]', error?.stack || error)).finally(() => {
      if (playerQueues.get(key) === next) playerQueues.delete(key)
    })
  }
  bot.on('botPlatformMessage', listener)
  const teleportListener = event => {
    handleTeleportRequest(event).catch(error => console.error('[smart-teleport]', error?.stack || error))
  }
  bot.on('botPlatformTeleportRequest', teleportListener)
  const startup = platform.request('volatile_schedules_reset', {}).catch(error => {
    console.error('[smart-volatile-schedules-reset]', error?.stack || error)
  })
  startup.then(() => ominousScheduler.start()).catch(error => console.error('[smart-ominous]', error?.stack || error))
  startup.then(() => periodicRightClickScheduler.start()).catch(error => console.error('[smart-periodic-right-click]', error?.stack || error))
  const runningScheduledTasks = new Set()
  const taskRetryAfter = new Map()
  let schedulerRetryAfter = 0
  const taskTimer = setInterval(async () => {
    if (Date.now() < schedulerRetryAfter) return
    try {
      await startup
      const result = await platform.request('task_list', {})
      const now = Date.now()
      for (const task of result.tasks || []) {
        const key = String(task.name).toLowerCase()
        if (!task.intervalTicks || !task.nextDueAt || task.nextDueAt > now || runningScheduledTasks.has(key) || Number(taskRetryAfter.get(key) || 0) > now) continue
        runningScheduledTasks.add(key)
        try {
          await runBotAction(() => executeCustomTask(bot, task))
          await platform.request('task_schedule_complete', { name: task.name })
          taskRetryAfter.delete(key)
        } catch (error) {
          taskRetryAfter.set(key, Date.now() + 5000)
          console.error('[smart-task-scheduler]', error?.message || error)
        } finally { runningScheduledTasks.delete(key) }
      }
    } catch (error) {
      schedulerRetryAfter = Date.now() + 5000
      console.error('[smart-task-scheduler]', error?.message || error)
    }
  }, 50)
  taskTimer.unref?.()
  return () => {
    bot.removeListener('botPlatformMessage', listener)
    bot.removeListener('botPlatformTeleportRequest', teleportListener)
    process.removeListener('message', settingsListener)
    ominousScheduler.stop()
    periodicRightClickScheduler.stop()
    clearInterval(taskTimer)
  }
}

module.exports = {
  COMMAND_TEXT,
  activateNearestVault,
  clearInventory,
  clearStaleVehicleReference,
  createBotActionQueue,
  createOminousBottleScheduler,
  createPeriodicRightClickScheduler,
  createPlayerMapClient,
  createSmartCommandHandler,
  createTeleportRequestHandler,
  dismountVehicle,
  drinkOminousBottle,
  executeCustomTask,
  findPlayerPosition,
  installSmartCommands,
  hasValidVehicleAttachment,
  isVersionNewer,
  isOminousBottleItem,
  mapDimensionLabel,
  mountNearestMinecart,
  normalizeCommandPrefixes,
  parseSmartCommand,
  parsePeriodicRightClickArgs,
  parseCoordinates,
  placePeriodicRightClick,
  rightClickTarget,
  formatScheduleStatus,
  SMART_BOT_VERSION,
  validateForwardCommand
}
