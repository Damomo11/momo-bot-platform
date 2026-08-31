const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { installSmartCommands } = require('./commands')

const bot = mineflayer.createBot({
  host: process.env.BOT_PLATFORM_SERVER_HOST,
  port: Number(process.env.BOT_PLATFORM_SERVER_PORT || 25565),
  username: process.env.BOT_PLATFORM_MICROSOFT_EMAIL,
  auth: 'microsoft',
  profilesFolder: process.env.BOT_PLATFORM_PROFILES_FOLDER,
  ...(process.env.BOT_PLATFORM_MINECRAFT_VERSION ? { version: process.env.BOT_PLATFORM_MINECRAFT_VERSION } : {})
})

bot.loadPlugin(pathfinder)
bot.once('spawn', () => {
  const movements = new Movements(bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.scafoldingBlocks = []
  bot.pathfinder.setMovements(movements)
})

const removeSmartCommands = installSmartCommands(bot)
bot.once('end', removeSmartCommands)

const MEMORY_LOG_INTERVAL_MS = 5 * 60 * 1000
const MEMORY_WARN_BYTES = 1200 * 1024 * 1024
const COLUMN_KEEP_RADIUS = 16

function pruneFarColumns (bot) {
  const columns = bot.world?.columns
  const position = bot.entity?.position
  if (!columns || !position) return
  const centerChunkX = Math.floor(position.x / 16)
  const centerChunkZ = Math.floor(position.z / 16)
  for (const key of Object.keys(columns)) {
    const separator = key.indexOf(',')
    const chunkX = Number(key.slice(0, separator))
    const chunkZ = Number(key.slice(separator + 1))
    if (!Number.isInteger(chunkX) || !Number.isInteger(chunkZ)) continue
    if (Math.max(Math.abs(chunkX - centerChunkX), Math.abs(chunkZ - centerChunkZ)) > COLUMN_KEEP_RADIUS) delete columns[key]
  }
}

function startMemoryWatchdog (bot) {
  const timer = setInterval(() => {
    try {
      const memory = process.memoryUsage()
      const chunks = Object.keys(bot.world?.columns || {}).length
      const entities = Object.keys(bot.entities || {}).length
      const players = Object.keys(bot.players || {}).length
      console.log(`[memory] heap ${(memory.heapUsed / 1048576).toFixed(0)}MB, rss ${(memory.rss / 1048576).toFixed(0)}MB, chunks ${chunks}, entities ${entities}, players ${players}`)
      if (memory.heapUsed > MEMORY_WARN_BYTES) console.warn('[memory] 堆内存超过 1200MB，接近 OOM 阈值。')
      pruneFarColumns(bot)
    } catch {}
  }, MEMORY_LOG_INTERVAL_MS)
  timer.unref?.()
}

startMemoryWatchdog(bot)
