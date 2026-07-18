const fs = require('node:fs')
const path = require('node:path')
const { Authflow, Titles } = require('prismarine-auth')

class AccountManager {
  constructor (db, config) {
    this.db = db
    this.config = config
    this.authorizing = new Map()
  }

  cacheFolder (id) {
    return path.join(this.config.authCacheRoot, 'accounts', id)
  }

  secureCacheFolder (folder) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(folder, 0o700) } catch {}
  }

  list (userId = null) {
    return this.db.listMicrosoftAccounts(userId)
  }

  create (userId, email) {
    return this.db.createMicrosoftAccount(userId, email)
  }

  authorize (id, actorUserId = null, force = false) {
    const account = this.db.getMicrosoftAccount(id)
    if (!account) throw new Error('微软账号不存在。')
    if (actorUserId && account.userId !== actorUserId) throw new Error('无权操作这个微软账号。')
    if (this.authorizing.has(id)) return account
    if (account.authState === 'authorized' && !force) return account

    const promise = this.runAuthorization(account, force).finally(() => this.authorizing.delete(id))
    this.authorizing.set(id, promise)
    return this.db.getMicrosoftAccount(id)
  }

  async runAuthorization (account, force) {
    const cacheFolder = this.cacheFolder(account.id)
    this.secureCacheFolder(cacheFolder)
    this.db.updateMicrosoftAccountAuth(account.id, { authState: 'authorizing', lastError: '', oauthJson: '' })
    try {
      const flow = new Authflow(account.email, cacheFolder, {
        flow: 'live',
        authTitle: Titles.MinecraftNintendoSwitch,
        deviceType: 'Nintendo',
        forceRefresh: Boolean(force)
      }, code => {
        const oauth = {
          userCode: String(code?.user_code || code?.userCode || ''),
          verificationUri: String(code?.verification_uri || code?.verificationUri || 'https://microsoft.com/link'),
          directUri: String(code?.verification_uri_complete || code?.verificationUriComplete || ''),
          expiresAt: Date.now() + Number(code?.expires_in || code?.expiresIn || 900) * 1000
        }
        this.db.updateMicrosoftAccountAuth(account.id, { authState: 'auth_required', oauthJson: JSON.stringify(oauth) })
      })
      const session = await flow.getMinecraftJavaToken({ fetchProfile: true })
      this.db.updateMicrosoftAccountAuth(account.id, {
        authState: 'authorized',
        minecraftName: session?.profile?.name || '',
        lastError: '',
        oauthJson: ''
      })
    } catch (error) {
      this.db.updateMicrosoftAccountAuth(account.id, {
        authState: 'error',
        lastError: error.message || String(error),
        oauthJson: ''
      })
    }
  }

  remove (id, actorUserId = null) {
    const account = this.db.getMicrosoftAccount(id)
    if (!account) throw new Error('微软账号不存在。')
    if (actorUserId && account.userId !== actorUserId) throw new Error('无权操作这个微软账号。')
    if (this.authorizing.has(id)) throw new Error('账号正在授权，暂时不能删除。')
    this.db.deleteMicrosoftAccount(id)
    const folder = path.resolve(this.cacheFolder(id))
    const root = path.resolve(this.config.authCacheRoot, 'accounts') + path.sep
    if (folder.startsWith(root)) fs.rmSync(folder, { recursive: true, force: true })
    return true
  }
}

module.exports = AccountManager
