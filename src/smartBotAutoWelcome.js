'use strict'

// 智能 bot 版本号与变更记录。
const SMART_BOT_VERSION = '1.0.0'
const SMART_BOT_CHANGELOG = '1.0.0 新增自动欢迎：bot 检测到系统消息按钮事件（RUN_COMMAND / SUGGEST_COMMAND）中的 "/tsl bindwelcome <玩家名>" 命令时，自动代发该命令完成欢迎绑定（参考 minecraft-auto-reply 的按钮事件模式：只对点击事件携带的原始命令做正则匹配）。'

// 仅对命令做正则匹配（按钮事件模式）：任意玩家名，如 /tsl bindwelcome Damomo1。
const WELCOME_COMMAND_PATTERN = /^\/?tsl\s+bindwelcome\b/i

function collectClickCommands (component, out = []) {
  // 深度优先遍历文本组件树，收集 RUN_COMMAND / SUGGEST_COMMAND 的原始命令。
  // 兼容两代点击事件格式：
  //   老格式（~1.21.4）：clickEvent { action: 'run_command'|'suggest_command', value: '...' }
  //   新格式（1.21.5+）：click_event { action, command }，容器键 extra / raw
  if (!component || typeof component !== 'object') return out
  const click = component.clickEvent || component.click_event
  if (click && typeof click === 'object') {
    const action = String(click.action || '').toLowerCase()
    const command = click.value ?? click.command
    if ((action === 'run_command' || action === 'suggest_command') && typeof command === 'string' && command.trim()) {
      out.push(command)
    }
  }
  if (Array.isArray(component.extra)) for (const item of component.extra) collectClickCommands(item, out)
  if (Array.isArray(component.raw)) for (const item of component.raw) collectClickCommands(item, out)
  return out
}

// 挂到 bot 上：监听系统消息原始包，检测到欢迎绑定按钮命令即代发。
// mineflayer 的 chat 事件只给纯文本、点击事件已被丢弃，按钮事件模式必须读原始包。
function installAutoWelcome (bot) {
  if (!bot?._client) return () => {}
  const seen = new Set()
  const handler = packet => {
    try {
      const commands = collectClickCommands(packet?.contents)
      for (const command of commands) {
        const text = command.trim()
        if (!WELCOME_COMMAND_PATTERN.test(text)) continue
        const full = text.startsWith('/') ? text : '/' + text
        // 同一按钮命令可能在 overlay 与主聊天栏重复推送，短窗内只代发一次。
        if (seen.has(full)) continue
        seen.add(full)
        const timer = setTimeout(() => seen.delete(full), 60000)
        timer.unref?.()
        console.log(`[smart-bot] ${SMART_BOT_VERSION} 自动欢迎：系统消息按钮事件检测到 "${full}"，已代发执行。`)
        bot.chat(full)
      }
    } catch {}
  }
  bot._client.on('system_chat', handler)
  return () => bot._client.removeListener('system_chat', handler)
}

module.exports = { SMART_BOT_VERSION, SMART_BOT_CHANGELOG, WELCOME_COMMAND_PATTERN, collectClickCommands, installAutoWelcome }
