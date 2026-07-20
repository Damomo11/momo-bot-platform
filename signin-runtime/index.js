const mineflayer = require('mineflayer')

// The signin command is maintained directly in this fixed Bot code.
const command = "/signin click"

const bot = mineflayer.createBot({
  host: process.env.BOT_PLATFORM_SERVER_HOST,
  port: Number(process.env.BOT_PLATFORM_SERVER_PORT || 25565),
  username: process.env.BOT_PLATFORM_MICROSOFT_EMAIL,
  auth: 'microsoft',
  profilesFolder: process.env.BOT_PLATFORM_PROFILES_FOLDER,
  ...(process.env.BOT_PLATFORM_MINECRAFT_VERSION ? { version: process.env.BOT_PLATFORM_MINECRAFT_VERSION } : {})
})

bot.once('spawn', async () => {
  await new Promise(resolve => setTimeout(resolve, 1500))
  bot.chat(command)
  await new Promise(resolve => setTimeout(resolve, 2500))
  global.botPlatform.success(`已执行签到命令：${command}`)
})
