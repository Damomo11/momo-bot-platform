// TSL 充值成功消息识别：三层管道（管理页多行正则 → 内置新旧格式 → 关键词启发式），
// 与 cloud-store 的 SubscriptionManager 同一套思路。这里只关心「收款方向」：
// bot 主动 /pay 出去的回执（已向 X 转账 N）不属于充值，识别为 insufficient 之外的
// 一律忽略——玩家在游戏里对 bot 说「收到」不会带货币单位，不会被误认。
// 收款方向的「收到」措辞、bot 名义转出的「已向/转出」措辞都要排除。

const LEGACY_PAYMENT_REGEX = String.raw`\[TSLLLLL\]\s*你已支付\s+(?<player>\S+)\s+(?<amount>\d+\.\d{2})\s+C`
// (?<![\d.]) 防止把 5.555 截成 555 入账：三位小数的金额宁可当未识别。
const DEFAULT_PAYMENT_REGEX = [
  String.raw`(?:已?支付|收到)\s*[「『"']?\s*(?<player>[A-Za-z0-9_\-]{1,16})\s*[」』"']?\s*(?:转来|转给|转入)?\s*的?\s*(?<![\d.])(?<amount>\d+(?:\.\d{1,2})?)\s*(?:枚|个)?\s*(?:TSLC|C)\b`,
  LEGACY_PAYMENT_REGEX
].join('\n')

const BUILTIN_PAYMENT_PATTERNS = [
  String.raw`\[TSLLLLL\]\s*你已支付\s+(?<player>\S+)\s+(?<amount>\d+(?:\.\d{1,2})?)\s*C`,
  String.raw`(?:已?支付|收到)\s*[「『"']?\s*(?<player>[A-Za-z0-9_\-]{1,16})\s*[」』"']?\s*(?:转来|转给|转入)?\s*的?\s*(?<![\d.])(?<amount>\d+(?:\.\d{1,2})?)\s*(?:枚|个)?\s*(?:TSLC|C)\b`
].map(source => new RegExp(source, 'i'))

// bot 名义下的转出回执（转给玩家 X）不是充值：「已向玩家」是新语法里 bot → 人的方向。
const PAYMENT_OUTGOING_PATTERN = new RegExp(String.raw`已?向\s*(?!你(?:的)?\s)(?:[「『"']\s*)?[A-Za-z0-9_\-]{1,16}(?:\s*[」』"'])?\s*(?:转账|转入|转来|支付|付款)|转出`)

// 「当前余额/剩余」后的数字不是到账金额。
const PAYMENT_BALANCE_SUFFIX_PATTERN = /(?:当前\s*)?(?:余额|剩余)\s*[:：]?\s*\d+(?:\.\d+)?/
const HEURISTIC_PLAYER_PATTERN = /^[A-Za-z0-9_\-]{1,16}$/

function amountToCents (text) {
  const raw = String(text || '').trim().replace(/^\+/, '')
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null
  const cents = Number.parseInt(raw.replace('.', '').padEnd(3, '0'), 10)
  return cents > 0 ? cents : null
}

function extractHeuristicPlayer (text) {
  const patterns = [
    /[「『"']\s*([^」』"'\s]{1,16})\s*[」』"']/,
    /(?:已?支付|收到)\s+([A-Za-z0-9_\-]{1,16})\s/,
    /(?:^|[\s>»】])\s*([A-Za-z0-9_\-]{1,16})\s*(?:支付|转账|转入|转来)/
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (!match) continue
    const candidate = match[1]?.trim()
    if (candidate && HEURISTIC_PLAYER_PATTERN.test(candidate)) return candidate
  }
  return null
}

// 启发式兜底：不依赖任何具体措辞，按「玩家名 + 带货币单位的金额」结构抽取。
function parsePaymentHeuristic (text) {
  const raw = String(text || '').trim()
  const balanceMatch = raw.match(PAYMENT_BALANCE_SUFFIX_PATTERN)
  const body = balanceMatch ? raw.slice(0, balanceMatch.index) : raw

  const player = extractHeuristicPlayer(body)
  if (!player) return null

  const amountMatch = body.match(/(?<![\d.])(\d+(?:\.\d{1,2})?)\s*(?:枚|个)?\s*(?:TSLC|C)\b/i)
  if (!amountMatch) return null
  const amountCents = amountToCents(amountMatch[1])
  if (!amountCents) return null
  return { player, amount: amountMatch[1], amountCents }
}

function compilePaymentRegexList (source) {
  const lines = String(source || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (!lines.length) throw new Error('充值正则不能为空。')
  const result = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    try {
      const regex = new RegExp(line, 'i')
      if (!line.includes('(?<player>') || !line.includes('(?<amount>')) {
        throw new Error('充值正则必须包含命名捕获组 player 和 amount。')
      }
      result.push(regex)
    } catch (error) {
      // 单行坏掉只跳过该行，不打断运行时识别。
      console.error(`[payment] 充值正则第 ${index + 1} 行无效，已忽略：${error.message}`)
    }
  }
  if (!result.length) throw new Error('充值正则没有可用的行。')
  return result
}

function matchPaymentPatterns (text, patterns) {
  for (const regex of patterns) {
    const match = regex.exec(text)
    if (!match) continue
    const player = String(match.groups?.player || '').trim()
    const amountCents = amountToCents(match.groups?.amount)
    if (!player || !amountCents) continue
    return { player, amount: String(match.groups.amount), amountCents }
  }
  return null
}

// 保存设置时用：任何一行无效都抛出带行号的错误，让管理页拿到明确反馈。
function validatePaymentRegex (source) {
  const lines = String(source || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (!lines.length) throw new Error('充值正则不能为空。')
  lines.forEach((line, index) => {
    try { new RegExp(line, 'i') } catch (error) { throw new Error(`充值正则第 ${index + 1} 行无效：${error.message}`) }
    if (!line.includes('(?<player>') || !line.includes('(?<amount>')) {
      throw new Error(`充值正则第 ${index + 1} 行必须包含命名捕获组 player 和 amount。`)
    }
  })
  return lines.join('\n')
}

// 识别一条 system 消息是否为「充值成功」（bot 收款方向的支付完成）。
// 返回 { kind: 'success', amount } 或 { kind: 'insufficient', amount } 或 null。
// insufficient 保持向后兼容：余额不足提示触发 top_up_cancel。
function recognizePaymentMessage (message, options = {}) {
  const text = String(message || '').trim()
  if (!text) return null

  const insufficientPattern = options.insufficientPattern || /^\[TSLLLLL\]\s*你的余额少于\s+(50\.00)\s+C\s*$/
  const insufficient = text.match(insufficientPattern)
  if (insufficient) return { kind: 'insufficient', amount: insufficient[1] }

  // 转出方向回执（bot 已向 X 转账/支付）不是充值；「向你转账」是收款方向不拦。
  if (PAYMENT_OUTGOING_PATTERN.test(text)) return null

  const customPatterns = options.paymentRegexSource ? (() => {
    try { return compilePaymentRegexList(options.paymentRegexSource) } catch { return null }
  })() : null
  let payment = customPatterns ? matchPaymentPatterns(text, customPatterns) : null
  if (!payment) payment = matchPaymentPatterns(text, BUILTIN_PAYMENT_PATTERNS)
  if (!payment) payment = parsePaymentHeuristic(text)
  if (!payment) return null

  const recipient = String(options.recipient || '')
  const isSelfIncoming = recipient && payment.player.toLowerCase() === recipient.toLowerCase()
  if (!isSelfIncoming) return null
  return { kind: 'success', amount: payment.amount, amountCents: payment.amountCents }
}

module.exports = {
  DEFAULT_PAYMENT_REGEX,
  LEGACY_PAYMENT_REGEX,
  amountToCents,
  validatePaymentRegex,
  compilePaymentRegexList,
  recognizePaymentMessage,
  parsePaymentHeuristic
}
