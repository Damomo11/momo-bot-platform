const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { version: SMART_BOT_VERSION } = require('./package.json')
const ITEM_NAME_ALIASES = require('./item-name-aliases.json')

const PLAYER_MAP_URL = 'https://map.zenoxs.cn/tiles/settings.json'
const OMINOUS_BOTTLE_INTERVAL_MS = 31 * 60 * 1000
const OMINOUS_BOTTLE_RETRY_MS = 60 * 1000
const FISHING_DEFAULT_INTERVAL_TICKS = 10
const OFF_HAND_SLOT = 45
const FISHING_ATTEMPT_TIMEOUT_MS = 90 * 1000

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
  vaultUsage: '正确格式: 开宝库 开，或 开宝库 关。',
  vaultEnabled: '自动开宝库已开启：被 /tpahere 传送到玩家身边时会自动开启附近的不祥宝库。',
  vaultDisabled: '自动开宝库已关闭。',
  clearEmpty: '机器人背包已经是空的。',
  clearSuccess: (stacks, items) => `背包已清空，共丢出 ${stacks} 组、${items} 个物品。`,
  clearFailure: (stacks, error) => `清空背包中断，已丢出 ${stacks} 组。原因: ${error}`,
  takeUsage: '正确格式: 拿出 物品中文名或id',
  takeSuccess: item => `已将 ${item} 拿到主手。`,
  takeMissing: item => `背包中没有 ${item}。`,
  offhandUsage: '正确格式: 副手',
  offhandSuccess: item => `已将主手的 ${item} 放到副手。`,
  offhandToHandSuccess: item => `已将副手的 ${item} 放到主手。`,
  offhandEmpty: '主手和副手都没有物品。',
  offhandFailure: '切换主手和副手失败，请稍后重试。',
  dropUsage: '正确格式: 丢弃 物品中文名或id',
  dropSuccess: (item, stacks, items) => `已丢弃背包中的全部 ${item}，共 ${stacks} 组、${items} 个。`,
  dropMissing: item => `背包中没有 ${item}。`,
  dropFailure: (item, items, reason) => `丢弃 ${item} 中断，已丢出 ${items} 个。原因: ${reason}`,
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
  rightClickUsage: '正确格式: 右键 准星、右键 玩家名，或 右键 x y z。',
  rightClickSuccess: '右键交互成功。',
  rightClickFailure: '右键交互失败，请确认目标存在且在交互距离内。',
  attackUsage: '正确格式: 攻击',
  attackSuccess: '已攻击准星指向的目标。',
  attackMiss: '准星方向没有可攻击目标，已挥动主手。',
  attackFailure: '攻击失败，请确认机器人已进入服务器。',
  digUsage: '正确格式: 挖掘 准星，或 挖掘 x y z。',
  digSuccess: '挖掘成功。',
  fishingUsage: '正确格式: 钓鱼 开 [间隔gt]，或 钓鱼 关；默认间隔 10gt。',
  fishingEnabled: ticks => `自动钓鱼已开启；主手持钓鱼竿时会朝准星方向抛竿，收竿后 ${ticks}gt 重抛。`,
  fishingDisabled: '自动钓鱼已关闭。',
  balanceResult: balance => `Bot 所有者当前拥有 ${balance} momoc。`,
  topUpUsage: '正确格式: 充值 金额，例如 充值 50。',
  topUpPending: amount => `正在支付 ${amount} C，等待服务器确认。`,
  topUpBusy: '上一笔充值仍在等待服务器确认。',
  topUpFailure: '充值指令发送失败，请稍后重试。',
  topUpSuccess: (amount, balance) => `充值成功，已增加 ${amount} momoc，当前余额 ${balance} momoc。`,
  autoRenewUsage: '正确格式: 自动续费 开，或 自动续费 关。',
  autoRenewEnabled: '自动续费已开启。',
  autoRenewDisabled: '自动续费已关闭。',
  tslInsufficient: amount => `tsl余额不足${amount}`,
  moveUsage: '正确格式: 移动 x y z [停止距离]，或 移动 玩家名 [停止距离]，或 移动 东|西|南|北 格数 [停止距离]',
  moveSuccess: '已移动到目标附近。',
  moveFailure: '移动失败，请确认目标可达。',
  lookUsage: '正确格式: 注视 玩家名',
  lookSuccess: '已调整视角。',
  lookFailure: '注视失败，请确认目标存在。',
  placeUsage: '正确格式: 放置 准星，或 放置 x y z。',
  placeSuccess: '放置成功。',
  taskScheduled: (name, ticks) => `定时任务 ${name} 已开启，每 ${ticks} 游戏刻执行一次。`,
  taskStopped: name => `定时任务 ${name} 已关闭。`,
  customTaskUsage: task => `正确格式: ${task.name}${task.parameters?.length ? ` ${task.parameters.join(' ')}` : ''}`,
  scheduleStatus: schedules => `定时：${schedules || '无'}`,
  taskUsage: '正确格式: 定时任务 任务名 5 [参数...]；关闭时使用 定时任务 任务名 关。',
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
  runtimeStarting: name => `${name} 正在上线。`,
  runtimeStopping: name => `${name} 正在下线。`,
  runtimeAlreadyOnline: name => `${name} 已经在线。`,
  runtimeAlreadyOffline: name => `${name} 已经下线。`,
  runtimeFailure: reason => `Bot 上下线失败：${reason || '平台暂时不可用'}。`,
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

function parseSmartCommand (message, prefixes = [], options = {}) {
  const text = String(message || '').replace(/喵[~～]/g, '').trim()
  if (!text) return null
  if (options.allowWithoutPrefix) {
    const parts = text.split(/\s+/)
    return { prefix: '', command: parts[0], args: parts.slice(1), body: text }
  }
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

function isOminousVault (block) {
  if (!isVaultBlock(block)) return false
  const props = block.properties || block._properties || (typeof block.getProperties === 'function' ? block.getProperties() : null) || {}
  const ominous = props.ominous
  if (ominous != null) return ominous === true || ominous === 'true'
  return /ominous|不祥/i.test(`${block?.name || ''} ${block?.displayName || ''}`)
}

const OMINOUS_TRIAL_KEY_ID = 'minecraft:ominous_trial_key'

function hasOminousTrialKey (bot) {
  if (bot.heldItem && normalizeItemId(bot.heldItem.name) === OMINOUS_TRIAL_KEY_ID) return true
  return Boolean(findInventoryItem(bot, OMINOUS_TRIAL_KEY_ID))
}

async function activateNearestOminousVault (bot, maxDistance = 6) {
  if (typeof bot.findBlock !== 'function') return { status: 'failed' }
  const vault = bot.findBlock({ matching: isOminousVault, maxDistance })
  if (!vault) return { status: 'missing' }
  if (!hasOminousTrialKey(bot)) return { status: 'missing_key' }
  if (!(bot.heldItem && normalizeItemId(bot.heldItem.name) === OMINOUS_TRIAL_KEY_ID)) {
    await collectItemToHand(bot, OMINOUS_TRIAL_KEY_ID)
  }
  activateBlockWithoutLook(bot, vault)
  return { status: 'activated', block: vault }
}

async function rightClickTarget (bot, args) {
  if (args.length === 1 && args[0] === '准星') {
    const target = blockAtCursorTarget(bot)
    activateBlockAtCursorWithoutLook(bot, target)
    return
  }
  if (args.length === 1) {
    const entity = Object.values(bot.entities || {}).filter(row => row?.type === 'player' && String(row.username || '').toLowerCase() === String(args[0]).toLowerCase())[0]
    if (!entity || !Number.isInteger(entity.id) || typeof bot._client?.write !== 'function') throw new Error('player missing')
    const distance = bot.entity?.position?.distanceTo?.(entity.position)
    if (!Number.isFinite(distance) || distance > 4.5) throw new Error('player out of reach')
    const hitY = Math.max(0.8, Number(entity.height || 1.8) * 0.65)
    if (typeof bot.lookAt === 'function') await bot.lookAt(entity.position.offset(0, hitY, 0), true)
    bot._client.write('use_entity', {
      target: entity.id,
      mouse: 2,
      x: 0,
      y: hitY,
      z: 0,
      sneaking: false,
      hand: 0
    })
    return
  }
  const point = parseCoordinates(args)
  const block = point && bot.blockAt?.(new Vec3(point.x, point.y, point.z))
  if (!block || block.name === 'air' || typeof bot.activateBlock !== 'function') throw new Error('block missing')
  await bot.activateBlock(block)
}

const BLOCK_FACE_VECTORS = Object.freeze({
  0: new Vec3(0, -1, 0),
  1: new Vec3(0, 1, 0),
  2: new Vec3(0, 0, -1),
  3: new Vec3(0, 0, 1),
  4: new Vec3(-1, 0, 0),
  5: new Vec3(1, 0, 0)
})

function pointInsideBlockShapes (shapes, point) {
  return shapes.some(shape => point.x >= shape[0] && point.x <= shape[3] && point.y >= shape[1] && point.y <= shape[4] && point.z >= shape[2] && point.z <= shape[5])
}

function cursorFaceId (block, cursor) {
  if (!Array.isArray(block?.shapes) || !block.shapes.length) return block?.face
  const sampleDistance = 0.0001
  const exposedFaces = Object.entries(BLOCK_FACE_VECTORS).filter(([, normal]) => {
    const inside = cursor.minus(normal.scaled(sampleDistance))
    const outside = cursor.plus(normal.scaled(sampleDistance))
    return pointInsideBlockShapes(block.shapes, inside) && !pointInsideBlockShapes(block.shapes, outside)
  })
  return exposedFaces.length === 1 ? Number(exposedFaces[0][0]) : block.face
}

function blockAtCursorTarget (bot, maxDistance = 4.5) {
  if (!bot.entity || typeof bot.blockAtCursor !== 'function') throw new Error('机器人尚未进入服务器。')
  const block = bot.blockAtCursor(maxDistance)
  if (!block || block.name === 'air') throw new Error('准星没有指向可交互的方块。')
  const cursor = block.intersect?.minus ? block.intersect.minus(block.position) : new Vec3(0.5, 0.5, 0.5)
  const faceId = cursorFaceId(block, cursor)
  const face = BLOCK_FACE_VECTORS[faceId]
  if (!face) throw new Error('准星没有指向可交互的方块。')
  return { block, face, faceId, cursor }
}

function activateBlockWithoutLook (bot, block, faceId = 1, cursor = new Vec3(0.5, 1, 0.5)) {
  if (!block?.position || typeof bot.supportFeature !== 'function' || typeof bot._client?.write !== 'function' || typeof bot.swingArm !== 'function') throw new Error('机器人尚未进入服务器。')
  const base = { location: block.position, direction: faceId }
  if (bot.supportFeature('blockPlaceHasHeldItem')) {
    const Item = require('prismarine-item')(bot.registry)
    bot._client.write('block_place', {
      ...base,
      heldItem: Item.toNotch(bot.heldItem),
      cursorX: cursor.scaled(16).x,
      cursorY: cursor.scaled(16).y,
      cursorZ: cursor.scaled(16).z
    })
  } else if (bot.supportFeature('blockPlaceHasHandAndIntCursor')) {
    bot._client.write('block_place', {
      ...base,
      hand: 0,
      cursorX: cursor.scaled(16).x,
      cursorY: cursor.scaled(16).y,
      cursorZ: cursor.scaled(16).z
    })
  } else if (bot.supportFeature('blockPlaceHasHandAndFloatCursor')) {
    bot._client.write('block_place', { ...base, hand: 0, cursorX: cursor.x, cursorY: cursor.y, cursorZ: cursor.z })
  } else if (bot.supportFeature('blockPlaceHasInsideBlock')) {
    bot._client.write('block_place', {
      ...base,
      hand: 0,
      cursorX: cursor.x,
      cursorY: cursor.y,
      cursorZ: cursor.z,
      insideBlock: false,
      sequence: 0,
      worldBorderHit: false
    })
  } else {
    throw new Error('当前服务器版本不支持准星方块交互。')
  }
  bot.swingArm('right')
}

function activateBlockAtCursorWithoutLook (bot, target) {
  return activateBlockWithoutLook(bot, target.block, target.faceId, target.cursor)
}

async function placeAtCursor (bot, maxDistance = 4.5) {
  if (!bot.heldItem) throw new Error('机器人主手没有可放置物品。')
  if (typeof bot._placeBlockWithOptions !== 'function') throw new Error('机器人尚未进入服务器。')
  const target = blockAtCursorTarget(bot, maxDistance)
  await bot._placeBlockWithOptions(target.block, target.face, { swingArm: 'right', forceLook: 'ignore', delta: target.cursor })
  return { placed: true }
}

async function attackAtCursor (bot, maxDistance = 3.5) {
  if (!bot.entity || typeof bot.entityAtCursor !== 'function') throw new Error('机器人尚未进入服务器。')
  const target = bot.entityAtCursor(maxDistance)
  if (!target) {
    if (typeof bot.swingArm !== 'function') throw new Error('机器人无法挥动主手。')
    bot.swingArm('right')
    return { status: 'miss', target: null }
  }
  if (typeof bot.attack !== 'function') throw new Error('机器人无法攻击目标。')
  await bot.attack(target)
  return { status: 'attacked', target }
}

// prismarine-item 在 1.20.5+ 组件物品上，enchants 返回的是组件原始对象
// （{ enchantments: [{id, level}], showTooltip }）而不是 {name, lvl} 数组，
// mineflayer 的 digTime 拿到后直接遍历，会抛 “enchantments is not iterable”。
// 这里先把附魔归一化成 prismarine-block 期望的数组，再替换 bot.digTime。
function normalizeItemEnchants (bot, item) {
  const enchants = item?.enchants
  if (Array.isArray(enchants)) return enchants
  const list = Array.isArray(enchants?.enchantments) ? enchants.enchantments : []
  return list.map(ench => ({
    name: ench.name ?? bot.registry?.enchantments?.[ench.id]?.name ?? null,
    lvl: ench.lvl ?? ench.level ?? 0
  }))
}

function hardenDigTime (bot) {
  if (typeof bot.digTime !== 'function' || bot.digTime.enchantsSafe) return
  const safeDigTime = block => {
    const heldItem = bot.heldItem
    let enchantments = normalizeItemEnchants(bot, heldItem)
    const helmet = bot.inventory?.slots?.[bot.getEquipmentDestSlot?.('head')]
    if (helmet) enchantments = enchantments.concat(normalizeItemEnchants(bot, helmet))
    return block.digTime(
      heldItem?.type ?? null,
      bot.game?.gameMode === 'creative',
      ['water', 'flowing_water'].includes(bot._getBlockAtEyeLevel?.()?.name),
      !bot.entity?.onGround,
      enchantments,
      bot.entity?.effects || {}
    )
  }
  safeDigTime.enchantsSafe = true
  bot.digTime = safeDigTime
}

async function digBlockTarget (bot, args) {
  let block = null
  if (args.length === 1 && args[0] === '准星') block = blockAtCursorTarget(bot).block
  else {
    const point = parseCoordinates(args)
    block = point && bot.blockAt?.(new Vec3(point.x, point.y, point.z))
  }
  if (!block || block.name === 'air') throw new Error('目标位置没有可破坏的方块。')
  if (block.diggable === false) throw new Error('该方块无法被破坏。')
  if (typeof bot.dig !== 'function') throw new Error('机器人尚未进入服务器。')
  await bot.dig(block)
}

function parseCoordinates (args) {
  if (!Array.isArray(args) || args.length !== 3 || !args.every(value => /^-?\d+$/.test(String(value)))) return null
  const [x, y, z] = args.map(Number)
  if (![x, y, z].every(Number.isInteger) || Math.abs(x) > 30000000 || Math.abs(z) > 30000000 || y < -2048 || y > 2048) return null
  return { x, y, z }
}

const ITEM_NAME_TO_ID = new Map(Object.entries(ITEM_NAME_ALIASES).map(([name, itemId]) => [String(name).trim().toLowerCase(), String(itemId).trim().toLowerCase()]))

function normalizeItemId (value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return ''
  const resolved = ITEM_NAME_TO_ID.get(text) || text
  return resolved.includes(':') ? resolved : `minecraft:${resolved}`
}

function displayItemId (value) {
  const text = normalizeItemId(value)
  return text || '物品'
}

function findInventoryItem (bot, itemId) {
  const target = normalizeItemId(itemId)
  if (!target || !bot?.inventory?.items) return null
  return bot.inventory.items().find(item => normalizeItemId(item?.name) === target)
}

function findPlayerEntity (bot, username) {
  const target = String(username || '').toLowerCase()
  if (!target) return null
  return Object.values(bot.entities || {}).find(row => row?.type === 'player' && String(row.username || '').toLowerCase() === target) || null
}

function moveDirectionOffset (direction, blocks) {
  const distance = Number(blocks)
  if (!Number.isInteger(distance) || distance < 1) return null
  const step = distance
  const normalized = String(direction || '').trim()
  const offsets = {
    东: new Vec3(step, 0, 0),
    西: new Vec3(-step, 0, 0),
    南: new Vec3(0, 0, step),
    北: new Vec3(0, 0, -step)
  }
  return offsets[normalized] || null
}

function createMoveGoal (plan) {
  if (!plan) return null
  if (plan.kind === 'player') {
    if (!plan.entity || !plan.entity.position || !Number.isFinite(Number(plan.stopDistance))) return null
    return new goals.GoalFollow(plan.entity, plan.stopDistance)
  }
  if (plan.kind === 'position') {
    const target = plan.target instanceof Vec3 ? plan.target : new Vec3(Number(plan.target?.x), Number(plan.target?.y), Number(plan.target?.z))
    if (![target.x, target.y, target.z].every(Number.isFinite) || !Number.isFinite(Number(plan.stopDistance))) return null
    return new goals.GoalNear(target.x, target.y, target.z, plan.stopDistance)
  }
  return null
}

function parseStopDistance (value, fallback = 0.3) {
  if (value === undefined || value === null || value === '') return fallback
  const distance = Number(value)
  if (!Number.isFinite(distance) || distance < 0 || distance > 64) return null
  return distance
}

function isValidMoveSyntax (args) {
  if (!Array.isArray(args) || !args.length) return false
  if ((args.length === 3 || args.length === 4) && parseCoordinates(args.slice(0, 3))) return parseStopDistance(args[3], 0.3) !== null
  if ((args.length === 2 || args.length === 3) && moveDirectionOffset(args[0], args[1])) return parseStopDistance(args[2], 0.3) !== null
  if (args.length === 1) return String(args[0] || '').trim().length > 0
  if (args.length === 2 && String(args[0] || '').trim().length > 0) return parseStopDistance(args[1], 2) !== null
  return false
}

function resolveMovePlan (bot, args) {
  if (!Array.isArray(args) || !args.length) return null
  if (args.length === 3 || args.length === 4) {
    const coords = parseCoordinates(args.slice(0, 3))
    if (coords) {
      const stopDistance = parseStopDistance(args[3], 0.3)
      if (stopDistance === null) return null
      return { kind: 'position', target: new Vec3(coords.x, coords.y, coords.z), stopDistance }
    }
  }
  if (args.length === 2 || args.length === 3) {
    const offset = moveDirectionOffset(args[0], args[1])
    if (offset) {
      const base = bot.entity?.position
      if (!base) return null
      const stopDistance = parseStopDistance(args[2], 0.3)
      if (stopDistance === null) return null
      return { kind: 'position', target: base.plus(offset), stopDistance }
    }
  }
  if (args.length === 1 || args.length === 2) {
    const entity = findPlayerEntity(bot, args[0])
    if (!entity) return null
    const stopDistance = parseStopDistance(args[1], 2)
    if (stopDistance === null) return null
    return { kind: 'player', entity, stopDistance }
  }
  return null
}

async function moveTowardsTarget (bot, plan) {
  if (!bot.entity?.position || !bot.pathfinder?.goto || typeof bot.pathfinder.setGoal !== 'function') throw new Error('机器人尚未进入服务器。')
  const goal = createMoveGoal(plan)
  if (!goal) throw new Error('目标不存在。')
  const timeoutMs = Math.max(8000, Math.min(45000, Math.ceil((bot.entity.position.distanceTo(plan.kind === 'player' ? plan.entity.position : plan.target) + 8) * 1200)))
  let timeoutTimer
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise((_, reject) => {
        timeoutTimer = setTimeout(() => {
          try { bot.pathfinder.setGoal(null) } catch {}
          reject(new Error('移动超时，请确认目标可达。'))
        }, timeoutMs)
        timeoutTimer.unref?.()
      })
    ])
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
  }
  return { status: 'arrived' }
}

async function collectItemToHand (bot, itemId) {
  if (!bot.entity || !bot.inventory || typeof bot.equip !== 'function') throw new Error('机器人尚未进入服务器。')
  const target = displayItemId(itemId)
  const item = findInventoryItem(bot, itemId)
  if (!item) throw new Error(target)
  await bot.equip(item, 'hand')
  return { item: item.name || target }
}

async function moveHeldItemToOffhand (bot) {
  if (!bot.entity || !bot.inventory || typeof bot.equip !== 'function') throw new Error('机器人尚未进入服务器。')
  const heldItem = bot.heldItem
  const item = heldItem || bot.inventory.slots?.[OFF_HAND_SLOT]
  if (!item) {
    const error = new Error('主手和副手都没有物品。')
    error.code = 'HAND_EMPTY'
    throw error
  }
  const destination = heldItem ? 'off-hand' : 'hand'
  await bot.equip(item, destination)
  return { destination, item: item.name || '物品' }
}

async function discardInventoryItems (bot, itemId) {
  if (!bot.entity || !bot.inventory || typeof bot.tossStack !== 'function') throw new Error('机器人尚未进入服务器。')
  const target = displayItemId(itemId)
  if (!findInventoryItem(bot, target)) {
    const error = new Error(target)
    error.code = 'ITEM_MISSING'
    throw error
  }
  let stacks = 0
  let items = 0
  while (true) {
    const item = findInventoryItem(bot, target)
    if (!item) return { item: target, stacks, items }
    if (stacks >= 64) {
      const error = new Error('库存状态长时间未更新，已停止继续丢弃。')
      error.droppedStacks = stacks
      error.droppedItems = items
      throw error
    }
    try {
      await bot.tossStack(item)
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      error.droppedStacks = stacks
      error.droppedItems = items
      throw error
    }
    stacks += 1
    items += Number(item.count || 0)
  }
}

async function lookAtPlayer (bot, username) {
  const entity = findPlayerEntity(bot, username)
  if (!entity) throw new Error('player missing')
  if (typeof bot.lookAt !== 'function') throw new Error('机器人无法调整视角。')
  await bot.lookAt(entity.position.offset(0, 1.2, 0), true)
  return { username: entity.username || username }
}

function isFishingRodHeld (bot) {
  return normalizeItemId(bot?.heldItem?.name || bot?.heldItem?.displayName) === 'minecraft:fishing_rod'
}

async function fishAtCursor (bot) {
  if (!bot?.entity || typeof bot.fish !== 'function') throw new Error('机器人尚未进入服务器。')
  if (!isFishingRodHeld(bot)) throw new Error('机器人主手没有钓鱼竿。')
  await bot.fish()
  return { caught: true }
}

function createFishingController (bot, options = {}) {
  const platform = options.platform || global.botPlatform
  const runBotAction = options.runBotAction || (task => task())
  const fish = options.fishAtCursor || options.fish || fishAtCursor
  const setTimer = options.setTimer || setTimeout
  const clearTimer = options.clearTimer || clearTimeout
  const attemptTimeoutMs = options.fishingAttemptTimeoutMs || FISHING_ATTEMPT_TIMEOUT_MS
  const logger = options.logger || console
  let timer = null
  let enabled = false
  let stopped = false
  let running = false
  let lineActive = false
  let intervalTicks = FISHING_DEFAULT_INTERVAL_TICKS
  let lastWarning = ''
  let lastWarningAt = 0

  function cancelTimer () {
    if (timer) clearTimer(timer)
    timer = null
  }

  function warn (error) {
    const message = String(error?.message || error)
    const now = Date.now()
    if (message === lastWarning && now - lastWarningAt < 60000) return
    lastWarning = message
    lastWarningAt = now
    logger.warn?.(`[smart-fishing] ${message}`)
  }

  function arm (milliseconds = intervalTicks * 50) {
    cancelTimer()
    if (stopped || !enabled) return
    timer = setTimer(run, Math.max(0, milliseconds))
    timer?.unref?.()
  }

  async function fishWithTimeout () {
    let timeoutTimer = null
    let finished = false
    const fishing = fish(bot)
    const timeout = new Promise((resolve, reject) => {
      timeoutTimer = setTimer(() => {
        if (finished) return
        if (isFishingRodHeld(bot) && typeof bot.activateItem === 'function') {
          try { bot.activateItem() } catch {}
        }
        reject(new Error(`单次钓鱼超过 ${Math.ceil(attemptTimeoutMs / 1000)} 秒，已自动收竿重试。`))
      }, attemptTimeoutMs)
      timeoutTimer?.unref?.()
    })
    try {
      await Promise.race([fishing, timeout])
    } finally {
      finished = true
      if (timeoutTimer) clearTimer(timeoutTimer)
    }
  }

  async function run () {
    timer = null
    if (stopped || !enabled || running) return
    if (!isFishingRodHeld(bot)) {
      arm()
      return
    }
    running = true
    try {
      await runBotAction(async () => {
        if (stopped || !enabled || !isFishingRodHeld(bot)) return
        lineActive = true
        try {
          await fishWithTimeout()
        } finally {
          lineActive = false
        }
      })
    } catch (error) {
      if (enabled && !stopped) warn(error)
    } finally {
      running = false
      if (enabled && !stopped) arm()
    }
  }

  function setEnabled (next) {
    const value = Boolean(next)
    if (value === enabled) return { enabled }
    enabled = value
    if (enabled) {
      arm(0)
    } else {
      cancelTimer()
      if (lineActive && isFishingRodHeld(bot) && typeof bot.activateItem === 'function') {
        try { bot.activateItem() } catch {}
      }
    }
    return { enabled }
  }

  function applySettings (next) {
    const requestedIntervalTicks = Number(next?.fishingIntervalTicks)
    const nextIntervalTicks = Number.isInteger(requestedIntervalTicks) && requestedIntervalTicks >= 1 && requestedIntervalTicks <= 1728000
      ? requestedIntervalTicks
      : FISHING_DEFAULT_INTERVAL_TICKS
    const intervalChanged = nextIntervalTicks !== intervalTicks
    const wasEnabled = enabled
    intervalTicks = nextIntervalTicks
    setEnabled(Boolean(next?.fishingEnabled))
    if (enabled && wasEnabled && intervalChanged && !running) arm()
    return { fishingEnabled: enabled, fishingIntervalTicks: intervalTicks }
  }

  async function start () {
    if (!platform?.request) return applySettings({ fishingEnabled: false })
    return applySettings(await platform.request('fishing_schedule_get', {}))
  }

  function stop () {
    stopped = true
    enabled = false
    cancelTimer()
    if (lineActive && isFishingRodHeld(bot) && typeof bot.activateItem === 'function') {
      try { bot.activateItem() } catch {}
    }
  }

  return { applySettings, getState: () => ({ enabled, intervalTicks, running: lineActive }), runNow: run, setEnabled, start, stop }
}

const VAULT_OPEN_SCAN_INTERVAL_MS = 500
const VAULT_OPEN_MAX_ATTEMPTS = 60
const VAULT_LANDING_CHECK_MS = 250
const VAULT_LANDING_TIMEOUT_MS = 5000

function createVaultAutoOpenController (bot, options = {}) {
  const platform = options.platform || global.botPlatform
  const runBotAction = options.runBotAction || (task => task())
  const setTimer = options.setTimer || setTimeout
  const clearTimer = options.clearTimer || clearTimeout
  const logger = options.logger || console
  const maxDistance = Number(options.vaultMaxDistance) > 0 ? Number(options.vaultMaxDistance) : 6
  const scanIntervalMs = Number(options.vaultScanIntervalMs) > 0 ? Number(options.vaultScanIntervalMs) : VAULT_OPEN_SCAN_INTERVAL_MS
  const maxAttempts = Number(options.vaultMaxAttempts) > 0 ? Number(options.vaultMaxAttempts) : VAULT_OPEN_MAX_ATTEMPTS
  let scanTimer = null
  let landingTimer = null
  let enabled = false
  let stopped = false
  let attempts = 0

  function cancelTimers () {
    if (scanTimer) clearTimer(scanTimer)
    scanTimer = null
    if (landingTimer) clearTimer(landingTimer)
    landingTimer = null
  }

  function continueScanning () {
    if (stopped || !enabled) return
    attempts += 1
    if (attempts >= maxAttempts) {
      logger.warn?.(`[smart-vault] 传送后约 ${Math.round(maxAttempts * scanIntervalMs / 1000)} 秒内未发现不祥宝库，停止本次扫描。`)
      return
    }
    scanTimer = setTimer(poll, scanIntervalMs)
    scanTimer?.unref?.()
  }

  function poll () {
    scanTimer = null
    if (stopped || !enabled) return
    runBotAction(async () => {
      if (stopped || !enabled) return null
      return activateNearestOminousVault(bot, maxDistance)
    }).then(result => {
      if (stopped || !enabled) return
      if (result?.status === 'activated') {
        logger.log?.(`[smart-vault] 已隔方块开启不祥宝库 ${result.block?.position || ''}`)
        return
      }
      if (result?.status === 'missing_key') {
        logger.warn?.('[smart-vault] 背包中没有不祥试炼钥匙，本次传送不再尝试开宝库。')
        return
      }
      if (result?.status === 'failed') throw new Error('当前服务器版本不支持隔方块开宝库。')
      continueScanning()
    }).catch(error => {
      logger.warn?.(`[smart-vault] ${error?.message || error}`)
      continueScanning()
    })
  }

  function scheduleOpen (beforePosition = null) {
    if (stopped || !enabled) return
    cancelTimers()
    attempts = 0
    const position = bot.entity?.position
    if (!beforePosition || !position || typeof position.distanceTo !== 'function') {
      poll()
      return
    }
    const startedAt = Date.now()
    const waitLanding = () => {
      landingTimer = setTimer(() => {
        landingTimer = null
        if (stopped || !enabled) return
        if (position.distanceTo(beforePosition) > 1 || Date.now() - startedAt >= VAULT_LANDING_TIMEOUT_MS) {
          poll()
          return
        }
        waitLanding()
      }, VAULT_LANDING_CHECK_MS)
      landingTimer?.unref?.()
    }
    waitLanding()
  }

  function setEnabled (next) {
    const value = Boolean(next)
    if (value === enabled) return { vaultAutoOpenEnabled: enabled }
    enabled = value
    if (!enabled) cancelTimers()
    return { vaultAutoOpenEnabled: enabled }
  }

  function applySettings (next) {
    return setEnabled(Boolean(next?.vaultAutoOpenEnabled))
  }

  async function start () {
    if (!platform?.request) return applySettings({ vaultAutoOpenEnabled: false })
    return applySettings(await platform.request('vault_auto_open_get', {}))
  }

  function stop () {
    stopped = true
    enabled = false
    cancelTimers()
  }

  return { applySettings, getState: () => ({ enabled }), scheduleOpen, setEnabled, start, stop }
}

function formatScheduleStatus (status = {}) {
  const automation = status.automation || {}
  const entries = []
  if (automation.ominousBottleEnabled) entries.push('灾厄之瓶')
  if (automation.fishingEnabled) entries.push(`自动钓鱼(${automation.fishingIntervalTicks || FISHING_DEFAULT_INTERVAL_TICKS}gt)`)
  if (automation.vaultAutoOpenEnabled) entries.push('自动开宝库')
  for (const task of status.tasks || []) entries.push(`定时任务 ${task.name}(${task.intervalTicks}gt)`)
  return entries.join('；') || '无'
}

async function executeCustomTask (bot, task, options = {}) {
  const failures = []
  const logger = options.logger || console
  const variables = bindTaskArguments(task, options.args || task.scheduleArgs || [])
  let commandIndex = 0
  for (const step of task.steps || []) {
    if (step.type === 'wait') await delay(step.ticks * 50)
    else if (step.type === 'command') {
      commandIndex += 1
      const args = (step.args || []).map(value => replaceTaskParameters(value, variables))
      try {
        validateCustomTaskCommand(step.command, args)
        if (step.command === '上车') await mountNearestMinecart(bot)
        else if (step.command === '下车') await dismountVehicle(bot)
        else if (step.command === '清空') await clearInventory(bot)
        else if (step.command === '拿出') await collectItemToHand(bot, args[0])
        else if (step.command === '丢弃') await discardInventoryItems(bot, args[0])
        else if (step.command === '副手') await moveHeldItemToOffhand(bot)
        else if (step.command === '切换') await bot.setQuickBarSlot(Number(args[0]) - 1)
        else if (step.command === '放置') {
          if (args.length === 1 && args[0] === '准星') await placeAtCursor(bot)
          else await placePeriodicRightClick(bot, { periodicRightClickX: Number(args[0]), periodicRightClickY: Number(args[1]), periodicRightClickZ: Number(args[2]) })
        }
        else if (step.command === '右键') await rightClickTarget(bot, args)
        else if (step.command === '攻击') await attackAtCursor(bot)
        else if (step.command === '挖掘') await digBlockTarget(bot, args)
        else if (step.command === '移动') {
          const plan = resolveMovePlan(bot, args)
          if (!plan) throw new Error('移动命令参数无效。')
          await moveTowardsTarget(bot, plan)
        }
        else if (step.command === '注视') await lookAtPlayer(bot, args[0])
        else if (step.command === '指令') bot.chat(args.join(' ').slice(0, 256))
      } catch (error) {
        const message = String(error?.message || error)
        failures.push({ commandIndex, command: step.command, message })
        logger.warn?.(`[smart-task] 任务 ${task.name || '未命名'} 第 ${commandIndex} 条指令“${step.command}”执行失败: ${message}`)
      }
    }
  }
  return { failures }
}

function bindTaskArguments (task, args = []) {
  const parameters = Array.isArray(task?.parameters) ? task.parameters : []
  const values = Array.isArray(args) ? args.map(value => String(value)) : []
  const valid = parameters.length === 0 ? values.length === 0 : parameters.length === 1 ? values.length >= 1 : values.length === parameters.length
  if (!valid) throw new Error(`任务“${task?.name || '未命名'}”需要 ${parameters.length} 个参数：${parameters.join(' ')}。`)
  return Object.fromEntries(parameters.map((name, index) => [name, parameters.length === 1 ? values.join(' ') : values[index]]))
}

function replaceTaskParameters (value, variables) {
  return String(value).replace(/\{([\p{L}_][\p{L}\p{N}_]{0,15})\}/gu, (match, name) => Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : match)
}

function validateCustomTaskCommand (command, args) {
  if (['上车', '下车', '清空', '副手', '攻击'].includes(command) && args.length) throw new Error(`${command} 命令不需要参数。`)
  if (['拿出', '丢弃'].includes(command) && (args.length !== 1 || !normalizeItemId(args[0]) || /\s/.test(args[0]))) throw new Error(`${command}命令需要一个物品中文名或 id。`)
  if (command === '切换' && (args.length !== 1 || !/^[1-9]$/.test(args[0]))) throw new Error('切换命令参数必须为 1-9。')
  if (command === '放置' && !(args.length === 1 && args[0] === '准星') && !parseCoordinates(args)) throw new Error('放置命令需要“准星”或三个有效整数坐标。')
  if (command === '挖掘' && !(args.length === 1 && args[0] === '准星') && !parseCoordinates(args)) throw new Error('挖掘命令需要“准星”或三个有效整数坐标。')
  if (command === '右键' && !((args.length === 1 && args[0].length <= 32 && !/\s/.test(args[0])) || parseCoordinates(args))) throw new Error('右键命令需要“准星”、玩家名或三个有效整数坐标。')
  if (command === '移动' && !isValidMoveSyntax(args)) throw new Error('移动命令需要坐标、玩家名或方向与距离。')
  if (command === '注视' && (args.length !== 1 || !args[0].length)) throw new Error('注视命令需要一个玩家名。')
  if (command === '指令') {
    const text = args.join(' ')
    if (!text || text.length > 256 || /[\r\n]/.test(text)) throw new Error('指令内容无效。')
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
  const applyFishingSettings = options.applyFishingSettings || (() => ({ fishingEnabled: false }))
  const applyVaultAutoOpenSettings = options.applyVaultAutoOpenSettings || (() => ({ vaultAutoOpenEnabled: false }))
  // 默认按 Bot 自身防重入；installSmartCommands 会传入与定时调度器共享的守卫，覆盖手动与定时重叠
  const handlerRunningTasks = new Map()
  const runTaskExclusive = options.runTaskExclusive || (async (task, args) => {
    const key = String(task?.name || '').toLowerCase()
    if (handlerRunningTasks.has(key)) return false
    const promise = (options.runBotAction || (inner => inner()))(() => executeCustomTask(bot, task, { args })).finally(() => handlerRunningTasks.delete(key))
    handlerRunningTasks.set(key, promise)
    await promise
    return true
  })
  const scheduleRestart = options.scheduleRestart || (callback => {
    const timer = setTimeout(callback, 600)
    timer.unref?.()
  })
  const versionNotifiedPlayers = options.versionNotifiedPlayers || new Set()

  if (!platform?.request) throw new Error(COMMAND_TEXT.platformUnavailable)

  const request = (action, payload) => platform.request(action, payload)
  const notifyNewVersion = async username => {
    const key = String(username || '').toLowerCase()
    if (versionNotifiedPlayers.has(key) || !/^[A-Za-z0-9_]{3,16}$/.test(String(username || ''))) return
    try {
      const latest = await request('runtime_version', {})
      if (!isVersionNewer(latest?.version, SMART_BOT_VERSION)) return
      const summary = latest?.release?.summary || latest?.release?.title || ''
      const note = summary ? ` 更新内容: ${summary}` : ''
      bot.chat(`/msg ${username} bot已有新版本，可在游戏内使用“重启”命令，重启后自动更新。${note}`.slice(0, 256))
      versionNotifiedPlayers.add(key)
      if (versionNotifiedPlayers.size > 512) versionNotifiedPlayers.clear()
    } catch (error) {
      platform.log?.(`检查智能 Bot 版本失败: ${error?.message || error}`)
    }
  }

  return async event => {
    if (!event?.username || String(event.username).toLowerCase() === String(bot.username || '').toLowerCase()) return
    const prefixes = getCommandPrefixes()
    const parsed = parseSmartCommand(event.message, prefixes, { allowWithoutPrefix: event.channel === 'private' })
    if (!parsed) return

    const username = String(event.username).replace(/^#/, '')
    platform.relatedLog?.(`玩家 ${username} 调用 Bot 指令：${[parsed.command, ...parsed.args].join(' ').slice(0, 400)}`)
    const replyText = (message, key, variables = {}) => {
      const overrides = options.getMessageOverrides?.() || {}
      const template = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : message
      const replyVariables = { ...variables, sender: username }
      return String(template ?? '').replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(replyVariables, name) ? String(replyVariables[name]) : match)
    }
    const reply = (message, key, variables = {}) => {
      const value = replyText(message, key, variables)
      if (value !== '') bot.chat(value.slice(0, 256))
      return value
    }
    platform.log?.(`命令匹配 · ${username}: ${String(event.message || '').slice(0, 240)}`)
    const access = await request('access', { username })
    if (access.blacklisted) return

    // Runtime control is deliberately restricted to super-admins. The
    // request is tied to this Bot's instance by the supervisor and may target
    // another smart Bot only when it is on the same Minecraft server.
    if (parsed.command === '上线' || parsed.command === '下线') {
      if (parsed.args.length || !access.admin) return
      try {
        await request('runtime_control', {
          username,
          operation: parsed.command === '上线' ? 'start' : 'stop',
          targetBotId: process.env.BOT_PLATFORM_INSTANCE_ID
        })
      } catch (error) {
        platform.log?.(`Bot 上下线请求失败: ${error?.message || error}`)
      }
      return
    }

    if (parsed.command === '版本') {
      if (!access.whitelisted && !access.admin) return
      bot.chat(`智能 Bot 当前运行版本：v${SMART_BOT_VERSION}`)
      try {
        const latest = await request('runtime_version', {})
        const summary = latest?.release?.summary || latest?.release?.title || ''
        if (isVersionNewer(latest?.version, SMART_BOT_VERSION)) {
          bot.chat(`智能 Bot 最新版本：v${latest.version}${summary ? `；更新内容：${summary}` : ''}`.slice(0, 256))
        } else if (String(latest?.version || '') === SMART_BOT_VERSION) {
          bot.chat(`智能 Bot 当前已是最新版${summary ? `；本版说明：${summary}` : ''}`.slice(0, 256))
        }
      } catch {}
      return
    }

    if (access.admin) await notifyNewVersion(username)

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

    if (parsed.command === '余额') {
      if (!access.admin) return
      if (parsed.args.length) return
      const result = await request('owner_balance', { username })
      if (!result.allowed) return
      const balance = formatMomoc(result.balance)
      reply(COMMAND_TEXT.balanceResult(balance), 'balanceResult', { balance })
      return
    }

    if (parsed.command === '充值') {
      if (!access.admin) return
      if (parsed.args.length !== 1 || !/^\d+(?:\.\d{1,2})?$/.test(parsed.args[0]) || Number(parsed.args[0]) <= 0) return reply(COMMAND_TEXT.topUpUsage, 'topUpUsage')
      let prepared
      try {
        prepared = await request('top_up_prepare', { username, amount: parsed.args[0] })
        if (!prepared.allowed) return
      } catch (error) {
        return reply(/等待服务器确认/.test(String(error?.message || '')) ? COMMAND_TEXT.topUpBusy : COMMAND_TEXT.topUpFailure, /等待服务器确认/.test(String(error?.message || '')) ? 'topUpBusy' : 'topUpFailure')
      }
      try {
        const settings = options.getTopUpSettings?.() || {}
        const recipient = String(settings.recipient || 'Damomo1')
        const commandTemplate = String(settings.commandTemplate || '/pay {recipient} {amount}')
        const command = commandTemplate.replace(/\{recipient\}/g, recipient).replace(/\{amount\}/g, prepared.amount)
        await runBotAction(() => bot.chat(command))
        reply(COMMAND_TEXT.topUpPending(prepared.amount), 'topUpPending', { amount: prepared.amount })
      } catch {
        await request('top_up_cancel', {}).catch(() => {})
        reply(COMMAND_TEXT.topUpFailure, 'topUpFailure')
      }
      return
    }

    if (parsed.command === '自动续费') {
      if (!access.admin) return
      if (parsed.args.length !== 1 || !['开', '关'].includes(parsed.args[0])) return reply(COMMAND_TEXT.autoRenewUsage, 'autoRenewUsage')
      const enabled = parsed.args[0] === '开'
      const result = await request('auto_renew_set', { username, enabled })
      if (!result?.allowed) return
      reply(enabled ? COMMAND_TEXT.autoRenewEnabled : COMMAND_TEXT.autoRenewDisabled, enabled ? 'autoRenewEnabled' : 'autoRenewDisabled')
      return
    }

    const overridableTaskCommands = new Set(['上车', '下车', '开宝库', '清空', '拿出', '丢弃', '副手', '切换', '放置', '右键', '攻击', '挖掘', '移动', '注视'])
    if (overridableTaskCommands.has(parsed.command)) {
      const customTask = await request('task_get', { name: parsed.command })
      if (customTask?.task) {
        try {
          bindTaskArguments(customTask.task, parsed.args)
        } catch {
          reply(COMMAND_TEXT.customTaskUsage(customTask.task), 'customTaskUsage')
          return
        }
        await runTaskExclusive(customTask.task, parsed.args)
        return
      }
    }

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
      if (parsed.args.length !== 1 || !['开', '关'].includes(parsed.args[0])) return reply(COMMAND_TEXT.vaultUsage, 'vaultUsage')
      const result = await request('vault_auto_open_set', { username, enabled: parsed.args[0] === '开' })
      if (!result.allowed) return
      const settings = applyVaultAutoOpenSettings(result.settings)
      reply(settings.vaultAutoOpenEnabled ? COMMAND_TEXT.vaultEnabled : COMMAND_TEXT.vaultDisabled, settings.vaultAutoOpenEnabled ? 'vaultEnabled' : 'vaultDisabled')
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

    if (parsed.command === '拿出') {
      if (parsed.args.length !== 1) return reply(COMMAND_TEXT.takeUsage, 'takeUsage')
      try {
        const result = await runBotAction(() => collectItemToHand(bot, parsed.args[0]))
        const item = displayItemId(result.item)
        reply(COMMAND_TEXT.takeSuccess(item), 'takeSuccess', { item })
      } catch (error) {
        const item = displayItemId(parsed.args[0])
        reply(COMMAND_TEXT.takeMissing(item), 'takeMissing', { item })
      }
      return
    }

    if (parsed.command === '丢弃') {
      if (parsed.args.length !== 1) return reply(COMMAND_TEXT.dropUsage, 'dropUsage')
      const item = displayItemId(parsed.args[0])
      try {
        const result = await runBotAction(() => discardInventoryItems(bot, parsed.args[0]))
        reply(COMMAND_TEXT.dropSuccess(result.item, result.stacks, result.items), 'dropSuccess', { item: result.item, stacks: result.stacks, items: result.items })
      } catch (error) {
        if (error?.code === 'ITEM_MISSING') reply(COMMAND_TEXT.dropMissing(item), 'dropMissing', { item })
        else {
          const items = Number(error?.droppedItems || 0)
          const reason = error?.message || '未知错误'
          reply(COMMAND_TEXT.dropFailure(item, items, reason), 'dropFailure', { item, items, reason })
        }
      }
      return
    }

    if (parsed.command === '副手') {
      if (parsed.args.length) return reply(COMMAND_TEXT.offhandUsage, 'offhandUsage')
      try {
        const result = await runBotAction(() => moveHeldItemToOffhand(bot))
        const item = displayItemId(result.item)
        const toHand = result.destination === 'hand'
        reply(toHand ? COMMAND_TEXT.offhandToHandSuccess(item) : COMMAND_TEXT.offhandSuccess(item), toHand ? 'offhandToHandSuccess' : 'offhandSuccess', { item })
      } catch (error) {
        if (error?.code === 'HAND_EMPTY') reply(COMMAND_TEXT.offhandEmpty, 'offhandEmpty')
        else reply(COMMAND_TEXT.offhandFailure, 'offhandFailure')
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

    if (parsed.command === '移动') {
      const plan = resolveMovePlan(bot, parsed.args)
      if (!plan) return reply(COMMAND_TEXT.moveUsage, 'moveUsage')
      try {
        await runBotAction(() => moveTowardsTarget(bot, plan))
        reply(COMMAND_TEXT.moveSuccess, 'moveSuccess')
      } catch {
        reply(COMMAND_TEXT.moveFailure, 'moveFailure')
      }
      return
    }

    if (parsed.command === '注视') {
      if (parsed.args.length !== 1) return reply(COMMAND_TEXT.lookUsage, 'lookUsage')
      try {
        await runBotAction(() => lookAtPlayer(bot, parsed.args[0]))
        reply(COMMAND_TEXT.lookSuccess, 'lookSuccess')
      } catch {
        reply(COMMAND_TEXT.lookFailure, 'lookFailure')
      }
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
      const cursor = parsed.args.length === 1 && parsed.args[0] === '准星'
      if (!point && !cursor) return reply(COMMAND_TEXT.placeUsage, 'placeUsage')
      try {
        await runBotAction(() => cursor ? placeAtCursor(bot) : placePeriodicRightClick(bot, { periodicRightClickX: point.x, periodicRightClickY: point.y, periodicRightClickZ: point.z }))
        reply(COMMAND_TEXT.placeSuccess, 'placeSuccess')
      } catch (error) { const reason = error?.message || '未知错误'; reply(reason, 'placeFailure', { reason }) }
      return
    }

    if (parsed.command === '右键') {
      if (!(parsed.args.length === 1 || parseCoordinates(parsed.args))) return reply(COMMAND_TEXT.rightClickUsage, 'rightClickUsage')
      try { await runBotAction(() => rightClickTarget(bot, parsed.args)); reply(COMMAND_TEXT.rightClickSuccess, 'rightClickSuccess') } catch { reply(COMMAND_TEXT.rightClickFailure, 'rightClickFailure') }
      return
    }

    if (parsed.command === '攻击') {
      if (parsed.args.length) return reply(COMMAND_TEXT.attackUsage, 'attackUsage')
      try {
        const result = await runBotAction(() => attackAtCursor(bot))
        reply(result.status === 'attacked' ? COMMAND_TEXT.attackSuccess : COMMAND_TEXT.attackMiss, result.status === 'attacked' ? 'attackSuccess' : 'attackMiss')
      } catch {
        reply(COMMAND_TEXT.attackFailure, 'attackFailure')
      }
      return
    }

    if (parsed.command === '挖掘') {
      const point = parseCoordinates(parsed.args)
      const cursor = parsed.args.length === 1 && parsed.args[0] === '准星'
      if (!point && !cursor) return reply(COMMAND_TEXT.digUsage, 'digUsage')
      try {
        await runBotAction(() => digBlockTarget(bot, parsed.args))
        reply(COMMAND_TEXT.digSuccess, 'digSuccess')
      } catch (error) { const reason = error?.message || '未知错误'; reply(reason, 'digFailure', { reason }) }
      return
    }

    if (parsed.command === '钓鱼') {
      const opening = parsed.args[0] === '开'
      const intervalText = String(parsed.args[1] || FISHING_DEFAULT_INTERVAL_TICKS)
      const intervalTicks = opening ? Number(intervalText) : null
      const validOpening = opening && parsed.args.length <= 2 && /^\d+$/.test(intervalText) && Number.isInteger(intervalTicks) && intervalTicks >= 1 && intervalTicks <= 1728000
      const validClosing = parsed.args[0] === '关' && parsed.args.length === 1
      if (!validOpening && !validClosing) return reply(COMMAND_TEXT.fishingUsage, 'fishingUsage')
      const result = await request('fishing_schedule_set', { username, enabled: opening, intervalTicks })
      if (!result.allowed) return
      const settings = applyFishingSettings(result.settings)
      const enabled = Boolean(settings?.fishingEnabled)
      const ticks = Number(settings?.fishingIntervalTicks || FISHING_DEFAULT_INTERVAL_TICKS)
      reply(enabled ? COMMAND_TEXT.fishingEnabled(ticks) : COMMAND_TEXT.fishingDisabled, enabled ? 'fishingEnabled' : 'fishingDisabled', { ticks })
      return
    }

    if (parsed.command === '定时任务') {
      if (parsed.args.length === 2 && parsed.args[1] === '关') {
        const result = await request('task_schedule_set', { username, name: parsed.args[0], intervalTicks: null })
        if (result.allowed) reply(COMMAND_TEXT.taskStopped(parsed.args[0]), 'taskStopped', { task: parsed.args[0] })
        return
      }
      const ticks = Number(String(parsed.args[1] || '').replace(/gt$/i, ''))
      if (parsed.args.length < 2 || !Number.isInteger(ticks) || ticks < 1) return reply(COMMAND_TEXT.taskUsage, 'taskUsage')
      const result = await request('task_schedule_set', { username, name: parsed.args[0], intervalTicks: ticks, args: parsed.args.slice(2) })
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
        try {
          bindTaskArguments(customTask.task, parsed.args)
        } catch {
          reply(COMMAND_TEXT.customTaskUsage(customTask.task), 'customTaskUsage')
          return
        }
        await runTaskExclusive(customTask.task, parsed.args)
        return
      }
    }

    if (!access.admin) return

    if (parsed.command === '重启') {
      if (access.lock.locked) return reply(COMMAND_TEXT.restartLocked, 'restartLocked')
      const prepared = await request('runtime_restart_prepare', { username })
      if (!prepared.allowed) {
        if (prepared.locked) reply(COMMAND_TEXT.restartLocked, 'restartLocked')
        return
      }
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
    if (access.blacklisted || !access.whitelisted) return
    if (event?.kind === 'to_bot') {
      if (access.lock?.adminLocked && !access.admin) return
    } else if (access.lock?.locked || access.lock?.adminLocked) return
    const beforePosition = typeof bot.entity?.position?.clone === 'function' ? bot.entity.position.clone() : null
    await runBotAction(() => bot.chat(`/tpaccept ${username}`))
    if (event?.kind === 'to_requester') options.onTeleported?.(username, beforePosition)
  }
}

function createPeekRequestHandler (bot, options = {}) {
  const platform = options.platform || global.botPlatform
  const runBotAction = options.runBotAction || (task => task())

  if (!platform?.request) throw new Error(COMMAND_TEXT.platformUnavailable)

  return async event => {
    const username = String(event?.username || '').replace(/^#/, '')
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username) || username.toLowerCase() === String(bot.username || '').toLowerCase()) return

    const access = await platform.request('access', { username })
    if (access.blacklisted || !access.whitelisted) return
    await runBotAction(() => bot.chat('/peek accept'))
  }
}

function formatMomoc (value) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 6 })
}

function installSmartCommands (bot, options = {}) {
  hardenDigTime(bot)
  const platform = options.platform || global.botPlatform
  const request = (action, payload) => platform.request(action, payload)
  const runBotAction = options.runBotAction || createBotActionQueue()
  // 同名任务执行期间忽略重复触发（聊天重发/玩家连发/定时重叠），并与调度器共享防重入
  const runningTasks = new Map()
  const runTaskExclusive = async (task, args) => {
    const key = String(task?.name || '').toLowerCase()
    if (runningTasks.has(key)) return false
    const promise = runBotAction(() => executeCustomTask(bot, task, { args })).finally(() => runningTasks.delete(key))
    runningTasks.set(key, promise)
    await promise
    return true
  }
  const ominousScheduler = options.ominousScheduler || createOminousBottleScheduler(bot, { ...options, platform, runBotAction })
  const periodicRightClickScheduler = options.periodicRightClickScheduler || createPeriodicRightClickScheduler(bot, { ...options, platform, runBotAction })
  const fishingController = options.fishingController || createFishingController(bot, { ...options, runBotAction })
  const vaultAutoOpenController = options.vaultAutoOpenController || createVaultAutoOpenController(bot, { ...options, runBotAction })
  let commandPrefix = String(options.commandPrefix ?? '')
  let messageOverrides = {}
  let topUpSettings = { recipient: 'Damomo1', commandTemplate: '/pay {recipient} {amount}' }
  const settingsListener = message => {
    if (message?.type === 'smart_settings') {
      commandPrefix = String(message.settings?.commandPrefix || '')
      messageOverrides = message.settings?.messageOverrides || {}
      topUpSettings = message.settings?.topUp || topUpSettings
    }
    if (message?.type === 'smart_top_up_settings') {
      topUpSettings = message.settings || topUpSettings
      bot.emit('botPlatformTopUpSettings', topUpSettings)
    }
    if (message?.type === 'smart_automation') {
      ominousScheduler.applySettings(message.automation || {})
      periodicRightClickScheduler.applySettings(message.automation || {})
      fishingController.applySettings(message.automation || {})
      vaultAutoOpenController.applySettings(message.automation || {})
    }
    if (message?.type === 'smart_daily_action' && ['signin', 'auto_renew'].includes(message.action) && String(message.command || '')) {
      runBotAction(() => bot.chat(String(message.command))).catch(error => console.error('[smart-daily-action]', error?.stack || error))
    }
  }
  process.on('message', settingsListener)
  platform?.request?.('settings', {}).then(settings => {
    commandPrefix = String(settings?.commandPrefix || '')
    messageOverrides = settings?.messageOverrides || {}
    topUpSettings = settings?.topUp || topUpSettings
    bot.emit('botPlatformTopUpSettings', topUpSettings)
  }).catch(error => console.error('[smart-settings]', error?.stack || error))

  const handle = createSmartCommandHandler(bot, {
    ...options,
    platform,
    runBotAction,
    runTaskExclusive,
    applyOminousSettings: settings => ominousScheduler.applySettings(settings),
    applyPeriodicRightClickSettings: settings => periodicRightClickScheduler.applySettings(settings),
    applyFishingSettings: settings => fishingController.applySettings(settings),
    applyVaultAutoOpenSettings: settings => vaultAutoOpenController.applySettings(settings),
    getCommandPrefixes: () => [commandPrefix, bot.username],
    getMessageOverrides: () => messageOverrides,
    getTopUpSettings: () => topUpSettings
  })
  const handleTeleportRequest = createTeleportRequestHandler(bot, { ...options, platform, runBotAction, onTeleported: (username, beforePosition) => vaultAutoOpenController.scheduleOpen(beforePosition) })
  const handlePeekRequest = createPeekRequestHandler(bot, { ...options, platform, runBotAction })
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
  let runtimeTargets = []
  let runtimeTargetsExpiresAt = 0
  let runtimeTargetsRequest = null
  const refreshRuntimeTargets = () => {
    if (runtimeTargetsRequest) return runtimeTargetsRequest
    if (Date.now() < runtimeTargetsExpiresAt) return Promise.resolve(runtimeTargets)
    runtimeTargetsRequest = request('runtime_targets', {}).then(result => {
      runtimeTargets = Array.isArray(result) ? result : []
      runtimeTargetsExpiresAt = Date.now() + 1000
      return runtimeTargets
    }).catch(() => runtimeTargets).finally(() => { runtimeTargetsRequest = null })
    return runtimeTargetsRequest
  }
  const remoteRuntimeListener = event => {
    if (!event?.username || String(event.username).toLowerCase() === String(bot.username || '').toLowerCase()) return
    refreshRuntimeTargets().then(targets => {
      const ownId = String(process.env.BOT_PLATFORM_INSTANCE_ID || '')
      const candidates = targets
        .filter(target => String(target.id) !== ownId && String(target.serverHost || '') === String(process.env.BOT_PLATFORM_SERVER_HOST || '') && Number(target.serverPort || 0) === Number(process.env.BOT_PLATFORM_SERVER_PORT || 25565))
        .sort((a, b) => (b.prefixes || []).reduce((n, p) => Math.max(n, String(p).length), 0) - (a.prefixes || []).reduce((n, p) => Math.max(n, String(p).length), 0))
      for (const target of candidates) {
        const parsed = parseSmartCommand(event.message, target.prefixes || [])
        if (!parsed || !['上线', '下线'].includes(parsed.command) || parsed.args.length) continue
        const operation = parsed.command === '上线' ? 'start' : 'stop'
        request('runtime_control', { username: String(event.username).replace(/^#/, ''), targetBotId: target.id, operation })
          .catch(error => platform.log?.(`代收 Bot 上下线请求失败: ${error?.message || error}`))
        return
      }
    }).catch(() => {})
  }
  bot.on('botPlatformMessage', remoteRuntimeListener)
  const teleportListener = event => {
    if (event?.kind === 'to_requester') platform.relatedLog?.(`玩家 ${String(event.username || '').replace(/^#/, '')} 向 Bot 发送了 /tpahere。`)
    handleTeleportRequest(event).catch(error => console.error('[smart-teleport]', error?.stack || error))
  }
  bot.on('botPlatformTeleportRequest', teleportListener)
  const peekListener = event => {
    handlePeekRequest(event).catch(error => console.error('[smart-peek]', error?.stack || error))
  }
  bot.on('botPlatformPeekRequest', peekListener)
  const paymentListener = event => {
    if (event?.kind === 'insufficient') {
      platform.request('top_up_cancel', {}).then(result => {
        if (!result?.silent) bot.chat(COMMAND_TEXT.tslInsufficient(String(event.amount || '')))
      }).catch(() => {})
      return
    }
    platform.request('top_up_confirm', { amount: event?.amount }).then(result => {
      if (!result?.confirmed) return
      if (result.silent) return
      const sender = String(result.sender || '')
      const template = Object.prototype.hasOwnProperty.call(messageOverrides, 'topUpSuccess') ? messageOverrides.topUpSuccess : COMMAND_TEXT.topUpSuccess(result.amount, formatMomoc(result.balance))
      const text = String(template || '').replace(/\{(sender|amount|balance)\}/g, (match, name) => ({ sender, amount: result.amount, balance: formatMomoc(result.balance) })[name])
      if (text) bot.chat(text.slice(0, 256))
    }).catch(error => console.error('[smart-top-up]', error?.stack || error))
  }
  bot.on('botPlatformPaymentMessage', paymentListener)
  const startup = platform.request('volatile_schedules_reset', {}).catch(error => {
    console.error('[smart-volatile-schedules-reset]', error?.stack || error)
  })
  startup.then(() => ominousScheduler.start()).catch(error => console.error('[smart-ominous]', error?.stack || error))
  startup.then(() => periodicRightClickScheduler.start()).catch(error => console.error('[smart-periodic-right-click]', error?.stack || error))
  startup.then(() => fishingController.start()).catch(error => console.error('[smart-fishing]', error?.stack || error))
  startup.then(() => vaultAutoOpenController.start()).catch(error => console.error('[smart-vault]', error?.stack || error))
  const taskRetryAfter = new Map()
  let schedulerRetryAfter = 0
  let tasksCache = []
  let tasksNextFetchAt = 0
  const taskTimer = setInterval(async () => {
    if (Date.now() < schedulerRetryAfter) return
    try {
      await startup
      const now = Date.now()
      if (now >= tasksNextFetchAt) {
        const result = await platform.request('task_list', {})
        tasksCache = result.tasks || []
        tasksNextFetchAt = now + 1000
      }
      for (const task of tasksCache) {
        const key = String(task.name).toLowerCase()
        if (!task.intervalTicks || !task.nextDueAt || task.nextDueAt > now || runningTasks.has(key) || Number(taskRetryAfter.get(key) || 0) > now) continue
        try {
          const ran = await runTaskExclusive(task, task.scheduleArgs || [])
          if (!ran) continue
          await platform.request('task_schedule_complete', { name: task.name })
          // 同步推进缓存里的 nextDueAt：否则 50ms tick 会拿着 1 秒内的旧缓存反复执行同一任务（连打攻击等步骤）
          task.nextDueAt = Date.now() + task.intervalTicks * 50
          taskRetryAfter.delete(key)
        } catch (error) {
          taskRetryAfter.set(key, Date.now() + 5000)
          console.error('[smart-task-scheduler]', error?.message || error)
        }
      }
    } catch (error) {
      schedulerRetryAfter = Date.now() + 5000
      console.error('[smart-task-scheduler]', error?.message || error)
    }
  }, 50)
  taskTimer.unref?.()
  return () => {
    bot.removeListener('botPlatformMessage', listener)
    bot.removeListener('botPlatformMessage', remoteRuntimeListener)
    bot.removeListener('botPlatformTeleportRequest', teleportListener)
    bot.removeListener('botPlatformPeekRequest', peekListener)
    bot.removeListener('botPlatformPaymentMessage', paymentListener)
    process.removeListener('message', settingsListener)
    ominousScheduler.stop()
    periodicRightClickScheduler.stop()
    fishingController.stop()
    vaultAutoOpenController.stop()
    clearInterval(taskTimer)
  }
}

module.exports = {
  COMMAND_TEXT,
  activateNearestOminousVault,
  attackAtCursor,
  clearInventory,
  clearStaleVehicleReference,
  createBotActionQueue,
  createFishingController,
  createVaultAutoOpenController,
  createOminousBottleScheduler,
  createPeriodicRightClickScheduler,
  createPlayerMapClient,
  createPeekRequestHandler,
  createSmartCommandHandler,
  createTeleportRequestHandler,
  discardInventoryItems,
  dismountVehicle,
  drinkOminousBottle,
  bindTaskArguments,
  executeCustomTask,
  findPlayerPosition,
  fishAtCursor,
  hardenDigTime,
  installSmartCommands,
  hasValidVehicleAttachment,
  isVersionNewer,
  isOminousBottleItem,
  isFishingRodHeld,
  mapDimensionLabel,
  mountNearestMinecart,
  moveHeldItemToOffhand,
  normalizeItemId,
  normalizeCommandPrefixes,
  normalizeItemEnchants,
  parseSmartCommand,
  parsePeriodicRightClickArgs,
  parseCoordinates,
  placeAtCursor,
  placePeriodicRightClick,
  rightClickTarget,
  formatScheduleStatus,
  SMART_BOT_VERSION,
  validateForwardCommand
}
