const fs = require('node:fs')
const path = require('node:path')

function loadConfig () {
  const root = path.resolve(__dirname, '..')
  const file = path.join(root, 'config.json')
  let local = {}
  if (fs.existsSync(file)) local = JSON.parse(fs.readFileSync(file, 'utf8'))
  return {
    root,
    host: process.env.BOT_PLATFORM_HOST || local.host || '127.0.0.1',
    port: Number(process.env.BOT_PLATFORM_PORT || local.port || 8788),
    supervisorPort: Number(process.env.BOT_PLATFORM_SUPERVISOR_PORT || local.supervisorPort || (Number(process.env.BOT_PLATFORM_PORT || local.port || 8788) + 1)),
    sessionDays: Number(local.sessionDays || 30),
    trustProxy: Boolean(local.trustProxy),
    secureCookies: Boolean(local.secureCookies),
    maxLoginFailures: Number(local.maxLoginFailures || 5),
    loginFailWindowMs: Number(local.loginFailWindowMs || 10 * 60 * 1000),
    loginBlockMs: Number(local.loginBlockMs || 10 * 60 * 1000),
    cloudStoreSsoSecretFile: path.resolve(root, process.env.BOT_PLATFORM_SSO_SECRET_FILE || local.cloudStoreSsoSecretFile || 'data/cloud-store-sso.key'),
    cloudStoreAdminUsername: String(process.env.BOT_PLATFORM_CLOUD_ADMIN || local.cloudStoreAdminUsername || 'Damomo1'),
    databasePath: path.resolve(root, process.env.BOT_PLATFORM_DATABASE_PATH || local.databasePath || 'data/bot-platform.sqlite'),
    authCacheRoot: path.resolve(root, process.env.BOT_PLATFORM_AUTH_CACHE_ROOT || local.authCacheRoot || 'auth-cache'),
    supervisorSecretFile: path.resolve(root, process.env.BOT_PLATFORM_SUPERVISOR_SECRET_FILE || local.supervisorSecretFile || 'data/bot-supervisor.key')
  }
}

module.exports = { loadConfig }
