# 智能 Bot 开发提示

开发或修改智能 Bot 功能时，请先阅读本提示。目标是避免“功能能运行，但网页、任务、提示、版本说明没有同步”的遗漏。

## 新增或修改智能 Bot 命令

涉及 `smart-runtime/commands.js` 的新命令、参数变化、权限变化或行为变化时，同步检查：

1. 运行时命令逻辑：`smart-runtime/commands.js`
   - 新增命令处理分支。
   - 新增或更新参数校验。
   - 新增或更新执行函数。
   - 命令涉及锁定、白名单、超管、黑名单时，确认权限路径没有绕过。

2. 自定义任务支持：`src/db.js`
   - 如果命令应该允许放进“自定义任务”，必须加入 `setSmartBotTask()` 的平台命令白名单。
   - 同步补齐保存时的参数校验，避免前端能选择、后端不能保存。
   - 如果命令运行时支持参数占位符，例如 `{玩家}`、`{x}`，保存校验也必须允许占位符。

3. 自定义任务执行：`smart-runtime/commands.js`
   - 在 `executeCustomTask()` 中支持该命令。
   - 在 `validateCustomTaskCommand()` 中补齐运行前校验。
   - 对可能失败的动作返回清晰失败原因，不要让整个任务无声中断。

4. 前端任务编辑器：`public/app.js`
   - 更新 `TASK_COMMANDS`。
   - 更新 `taskArgumentHint()`。
   - 如命令不需要参数，更新禁用参数输入框的逻辑。

5. 自定义文本编辑：`public/app.js`、`src/db.js`、`smart-runtime/commands.js`
   - 新增玩家可编辑回复时，更新 `MESSAGE_DEFAULTS`。
   - 更新 `MESSAGE_LABELS` 和 `MESSAGE_GROUPS`，让网页能编辑该文案。
   - 更新 `src/db.js` 中允许保存的消息 key 白名单。
   - 在运行时回复处使用对应 message key，确保玩家自定义文本能生效。

6. 命令帮助和说明：
   - 更新网页中的帮助分组、命令说明或示例。
   - 更新 `README.md` 中“智能 Bot 权限与命令”。
   - 如果功能模块帮助、管理面板或 Bot 列表也展示该命令，也要同步更新。

7. 测试：`test/platform.test.js`
   - 新增命令至少覆盖：直接游戏内命令、保存为自定义任务、执行自定义任务。
   - 如果有权限、锁定、定时、参数占位符、危险指令限制，也要覆盖对应边界。

## 版本和更新提示

下面两项不要擅自改，必须先向玩家或项目负责人确认后再修改：

1. 智能 Bot 版本号：`smart-runtime/package.json`
   - 例如从 `1.0.12` 升到 `1.0.13`。
   - 只有确认这是一个要发布给玩家看到的版本时才更新。

2. 智能 Bot 版本更新提示：`smart-runtime/releases.json`
   - 新增 release 条目时，需要确认标题、摘要和 highlights。
   - 文案会展示给玩家，不能只写开发内部说明。

确认后再更新版本信息，并确保版本号与 `releases.json` 最新条目一致。

## 提交前检查

提交或部署前至少运行：

```bash
npm run check
npm test
```

如果改了网页交互，手动打开页面验证对应流程：

- 创建或编辑智能 Bot。
- 创建自定义任务。
- 保存含新命令的任务。
- 在消息自定义页面编辑新文案。
- 查看命令帮助或说明是否出现新命令。

## 常见遗漏

- 前端 `TASK_COMMANDS` 有新命令，但 `src/db.js` 保存白名单没加。
- 运行时能执行新命令，但 `validateCustomTaskCommand()` 没加。
- 文案默认值加了，但数据库允许保存的 message key 没加。
- 命令帮助加了，但 README 或版本提示没同步。
- 改了行为但没有测试自定义任务路径。
- 未经确认就修改了 `smart-runtime/package.json` 版本号或 `smart-runtime/releases.json`。
