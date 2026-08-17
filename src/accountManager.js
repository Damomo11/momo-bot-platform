const fs = require('node:fs')
const path = require('node:path')
const { Authflow, Titles } = require('prismarine-auth')

class AccountManager {
  constructor (db, config) {
    this.db = db
    this.config = config
    this.authorizing = new Map()
    this.authorizationStartedAt = new Map()
    this.oauthRefreshStartedAt = new Map()
    this.authorizationCooldownMs = Number(config.accountAuthorizationCooldownMs ?? 30000)
    this.oauthRefreshCooldownMs = Number(config.accountOAuthRefreshCooldownMs ?? 60000)
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

  authorize (id, actorUserId = null, force = false, options = {}) {
    const account = this.db.getMicrosoftAccount(id)
    if (!account) throw new Error('微软账号不存在。')
    if (actorUserId && account.userId !== actorUserId) throw new Error('无权操作这个微软账号。')
    if (options.refreshCode) return this.refreshOAuthCode(account)
    if (this.authorizing.has(id)) return account
    if (account.authState === 'authorized' && !force) return account
    const remainingMs = this.authorizationCooldownMs - (Date.now() - Number(this.authorizationStartedAt.get(id) || 0))
    if (remainingMs > 0) {
      const error = new Error(`授权请求过于频繁，请 ${Math.ceil(remainingMs / 1000)} 秒后重试。`)
      error.status = 429
      throw error
    }

    this.authorizationStartedAt.set(id, Date.now())
    return this.beginAuthorization(account, force)
  }

  beginAuthorization (account, force = false) {
    const authorization = { cancelled: false }
    const promise = this.runAuthorization(account, force, authorization).finally(() => {
      if (this.authorizing.get(account.id) === authorization) this.authorizing.delete(account.id)
      if (authorization.cancelled) {
        try { this.removeCacheFolder(account.id) } catch {}
      }
    })
    authorization.promise = promise
    this.authorizing.set(account.id, authorization)
    return this.db.getMicrosoftAccount(account.id)
  }

  refreshOAuthCode (account) {
    if (account.authState === 'authorized') throw new Error('这个微软账号已经完成 OAuth2 授权。')
    const remainingMs = this.oauthRefreshCooldownMs - (Date.now() - Number(this.oauthRefreshStartedAt.get(account.id) || 0))
    if (remainingMs > 0) {
      const error = new Error(`OAuth 验证码更换过于频繁，请 ${Math.ceil(remainingMs / 1000)} 秒后重试。`)
      error.status = 429
      throw error
    }
    const authorization = this.authorizing.get(account.id)
    if (authorization) authorization.cancelled = true
    this.oauthRefreshStartedAt.set(account.id, Date.now())
    this.authorizationStartedAt.set(account.id, Date.now())
    this.removeCacheFolder(account.id)
    return this.beginAuthorization(account, true)
  }

  async runAuthorization (account, force, authorization) {
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
        if (authorization.cancelled) return
        const oauth = {
          userCode: String(code?.user_code || code?.userCode || ''),
          verificationUri: String(code?.verification_uri || code?.verificationUri || 'https://microsoft.com/link'),
          directUri: String(code?.verification_uri_complete || code?.verificationUriComplete || ''),
          expiresAt: Date.now() + Number(code?.expires_in || code?.expiresIn || 900) * 1000
        }
        this.db.updateMicrosoftAccountAuth(account.id, { authState: 'auth_required', oauthJson: JSON.stringify(oauth) })
      })
      const session = await flow.getMinecraftJavaToken({ fetchProfile: true })
      if (authorization.cancelled) return
      this.db.updateMicrosoftAccountAuth(account.id, {
        authState: 'authorized',
        minecraftName: session?.profile?.name || '',
        lastError: '',
        oauthJson: ''
      })
    } catch (error) {
      if (authorization.cancelled) return
      this.db.updateMicrosoftAccountAuth(account.id, {
        authState: 'error',
        lastError: error.message || String(error),
        oauthJson: ''
      })
    }
  }

  removeCacheFolder (id) {
    const folder = path.resolve(this.cacheFolder(id))
    const root = path.resolve(this.config.authCacheRoot, 'accounts') + path.sep
    if (folder.startsWith(root)) fs.rmSync(folder, { recursive: true, force: true })
  }

  remove (id, actorUserId = null) {
    const account = this.db.getMicrosoftAccount(id)
    if (!account) throw new Error('微软账号不存在。')
    if (actorUserId && account.userId !== actorUserId) throw new Error('无权操作这个微软账号。')
    const authorization = this.authorizing.get(id)
    if (authorization) authorization.cancelled = true
    this.db.deleteMicrosoftAccount(id)
    this.authorizationStartedAt.delete(id)
    this.oauthRefreshStartedAt.delete(id)
    this.removeCacheFolder(id)
    return true
  }
}

module.exports = AccountManager
