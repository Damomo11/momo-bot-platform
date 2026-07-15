const crypto = require('node:crypto')

function hashPassword (password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword (password, stored) {
  const [salt, expected] = String(stored || '').split(':')
  if (!salt || !expected) return false
  const actual = crypto.scryptSync(String(password), salt, 64)
  const expectedBuffer = Buffer.from(expected, 'hex')
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer)
}

function token () {
  return crypto.randomBytes(32).toString('base64url')
}

function tokenHash (value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

module.exports = { hashPassword, verifyPassword, token, tokenHash }
