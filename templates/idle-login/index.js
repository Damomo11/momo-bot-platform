const mineflayer = require('mineflayer')

const host = process.env.BOT_PLATFORM_SERVER_HOST
const username = process.env.BOT_PLATFORM_MICROSOFT_EMAIL
const variables = JSON.parse(process.env.BOT_PLATFORM_VARIABLES || '{}')

if (!host || !username) {
  throw new Error('This template must be started by Momo Bot Platform.')
}

const options = {
  host,
  port: Number(process.env.BOT_PLATFORM_SERVER_PORT || 25565),
  username,
  auth: 'microsoft',
  profilesFolder: process.env.BOT_PLATFORM_PROFILES_FOLDER
}

if (process.env.BOT_PLATFORM_MINECRAFT_VERSION) {
  options.version = process.env.BOT_PLATFORM_MINECRAFT_VERSION
}

const bot = mineflayer.createBot(options)

bot.once('spawn', () => {
  console.log(`Idle bot joined as ${bot.username}`)
  if (variables.join_message) bot.chat(variables.join_message)
})
