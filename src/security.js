class LoginAttemptLimiter {
  constructor (options = {}) {
    this.maxFailures = positiveInteger(options.maxFailures, 5)
    this.windowMs = positiveInteger(options.windowMs, 10 * 60 * 1000)
    this.blockMs = positiveInteger(options.blockMs, 10 * 60 * 1000)
    this.failures = new Map()
  }

  assertAllowed (key, now = Date.now()) {
    const id = String(key || 'unknown')
    const record = this.failures.get(id)
    if (!record?.blockedUntil) return
    if (record.blockedUntil <= now) {
      this.failures.delete(id)
      return
    }
    const error = new Error(`登录失败次数过多，请 ${Math.ceil((record.blockedUntil - now) / 1000)} 秒后再试。`)
    error.status = 429
    error.retryAfter = Math.ceil((record.blockedUntil - now) / 1000)
    throw error
  }

  recordFailure (key, now = Date.now()) {
    const id = String(key || 'unknown')
    const record = this.failures.get(id) || { count: 0, firstFailedAt: now, blockedUntil: 0 }
    if (now - record.firstFailedAt > this.windowMs) {
      record.count = 0
      record.firstFailedAt = now
      record.blockedUntil = 0
    }
    record.count += 1
    if (record.count >= this.maxFailures) record.blockedUntil = now + this.blockMs
    this.failures.set(id, record)
    return { ...record }
  }

  clear (key) {
    this.failures.delete(String(key || 'unknown'))
  }
}

function positiveInteger (value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function clientIp (req, trustProxy = false) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    if (forwarded) return forwarded
    const realIp = String(req.headers['x-real-ip'] || '').trim()
    if (realIp) return realIp
  }
  return req.socket.remoteAddress || 'unknown'
}

module.exports = { LoginAttemptLimiter, clientIp }
