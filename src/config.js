const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function loadConfig () {
  const root = path.resolve(__dirname, '..')
  const file = path.join(root, 'config.json')
  let local = {}
  if (fs.existsSync(file)) local = JSON.parse(fs.readFileSync(file, 'utf8'))
  const generatedAdminPassword = crypto.randomBytes(9).toString('base64url')
  return {
    root,
    host: process.env.BOT_PLATFORM_HOST || local.host || '127.0.0.1',
    port: Number(process.env.BOT_PLATFORM_PORT || local.port || 8788),
    sessionDays: Number(local.sessionDays || 30),
    bootstrapAdminUsername: process.env.BOT_PLATFORM_ADMIN_USER || local.bootstrapAdminUsername || 'admin',
    bootstrapAdminPassword: process.env.BOT_PLATFORM_ADMIN_PASSWORD || local.bootstrapAdminPassword || generatedAdminPassword,
    generatedAdminPassword: !process.env.BOT_PLATFORM_ADMIN_PASSWORD && !local.bootstrapAdminPassword,
    databasePath: path.join(root, 'data', 'bot-platform.sqlite'),
    authCacheRoot: path.join(root, 'auth-cache')
  }
}

module.exports = { loadConfig }
