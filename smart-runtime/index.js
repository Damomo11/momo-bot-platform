const mineflayer = require('mineflayer')
const { installSmartCommands } = require('./commands')

const bot = mineflayer.createBot({
  host: process.env.BOT_PLATFORM_SERVER_HOST,
  port: Number(process.env.BOT_PLATFORM_SERVER_PORT || 25565),
  username: process.env.BOT_PLATFORM_MICROSOFT_EMAIL,
  auth: 'microsoft',
  profilesFolder: process.env.BOT_PLATFORM_PROFILES_FOLDER,
  ...(process.env.BOT_PLATFORM_MINECRAFT_VERSION ? { version: process.env.BOT_PLATFORM_MINECRAFT_VERSION } : {})
})

const removeSmartCommands = installSmartCommands(bot)
bot.once('end', removeSmartCommands)
