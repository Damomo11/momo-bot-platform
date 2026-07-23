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
