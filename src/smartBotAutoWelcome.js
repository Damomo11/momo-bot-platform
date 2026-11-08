'use strict'

// 自动欢迎（按钮事件模式）：参考 minecraft-auto-reply，只对系统消息按钮事件
// （RUN_COMMAND / SUGGEST_COMMAND）携带的原始命令做正则匹配。
// 版本号与版本说明走 smart-runtime/package.json + releases.json（项目统一规范）。

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
// options.onTrigger：每次触发代发时回调（供调用方记"与 bot 相关"的日志）。
function installAutoWelcome (bot, options = {}) {
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
        if (typeof options.onTrigger === 'function') {
          try { options.onTrigger(full) } catch {}
        }
        bot.chat(full)
      }
    } catch {}
  }
  bot._client.on('system_chat', handler)
  return () => bot._client.removeListener('system_chat', handler)
}

module.exports = { WELCOME_COMMAND_PATTERN, collectClickCommands, installAutoWelcome }
