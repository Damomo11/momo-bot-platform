const crypto = require('node:crypto')

function verifyCloudStoreToken (token, secret, options = {}) {
  const key = String(secret || '').trim()
  if (key.length < 32) throw new Error('云仓库 SSO 密钥未配置或长度不足。')
  const [encoded, suppliedSignature, extra] = String(token || '').split('.')
  if (!encoded || !suppliedSignature || extra !== undefined) throw new Error('云仓库登录凭证格式无效。')
  const expectedSignature = crypto.createHmac('sha256', key).update(encoded).digest()
  let actualSignature
  try { actualSignature = Buffer.from(suppliedSignature, 'base64url') } catch {}
  if (!actualSignature || actualSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(actualSignature, expectedSignature)) {
    throw new Error('云仓库登录凭证签名无效。')
  }
  let payload
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) } catch {}
  const now = Number(options.now ?? Date.now())
  if (!payload || payload.iss !== 'cloud-store' || !payload.sub || !payload.nonce) throw new Error('云仓库登录凭证内容无效。')
  if (!/^[A-Za-z0-9_]{1,16}$/.test(String(payload.username || ''))) throw new Error('云仓库玩家 ID 无效。')
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || payload.iat > now + 30000 || payload.exp < now || payload.exp - payload.iat > 120000) {
    throw new Error('云仓库登录凭证已过期。')
  }
  return {
    externalId: String(payload.sub),
    username: String(payload.username),
    expiresAt: Number(payload.exp),
    nonce: String(payload.nonce)
  }
}

module.exports = { verifyCloudStoreToken }
