# Momo Bot Platform 模板开发硬性要求

你正在为 Momo Bot Platform 开发一个可直接上传运行的完整 Mineflayer 项目。请输出完整项目文件，不要只输出函数、片段或伪代码。所有实现必须遵守以下契约。

## 1. 项目结构

1. ZIP 根目录必须包含 `package.json`。
2. 入口按 `package.json.botPlatform.entry`、`package.json.main`、`index.js` 的顺序识别。
3. 所有运行依赖必须写入 `dependencies`。平台上传 ZIP 后会执行 `npm install --omit=dev`。
4. 项目必须使用 CommonJS，并支持平台当前使用的 Node.js 版本。
5. 一个项目进程只能创建一个 Mineflayer Bot，且只能调用一次 `mineflayer.createBot()`。

最小 `package.json`：

```json
{
  "name": "my-momo-bot-template",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "botPlatform": {
    "entry": "index.js",
    "variables": []
  },
  "dependencies": {
    "mineflayer": "^4.37.1"
  }
}
```

## 2. Minecraft 连接

模板只能使用 Microsoft OAuth2。账号、服务器和 OAuth 缓存由平台提供，不得在模板中硬编码账号、密码、Token 或服务器地址。

```js
const mineflayer = require('mineflayer')

const options = {
  host: process.env.BOT_PLATFORM_SERVER_HOST,
  port: Number(process.env.BOT_PLATFORM_SERVER_PORT || 25565),
  username: process.env.BOT_PLATFORM_MICROSOFT_EMAIL,
  auth: 'microsoft',
  profilesFolder: process.env.BOT_PLATFORM_PROFILES_FOLDER
}

if (process.env.BOT_PLATFORM_MINECRAFT_VERSION) {
  options.version = process.env.BOT_PLATFORM_MINECRAFT_VERSION
}

const bot = mineflayer.createBot(options)
```

平台会再次强制注入这些连接参数，并统一处理 OAuth、服务器资源包、协议降级、状态上报和进程隔离。模板不得自行创建第二个连接或绕过平台认证。

## 3. 用户变量

变量必须声明在 `package.json.botPlatform.variables`。支持的类型只有：

- `text`
- `textarea`
- `number`
- `boolean`
- `select`

变量 `key` 必须匹配 `^[a-z][a-z0-9_]{0,31}$`，同一模板内不能重复，最多 32 个变量。所有变量合计 JSON 不得超过 16000 字节。

```json
{
  "botPlatform": {
    "entry": "index.js",
    "variables": [
      {
        "key": "join_message",
        "label": "进服消息",
        "type": "text",
        "required": false,
        "default": "",
        "maxLength": 256,
        "placeholder": "例如 bot plat..test"
      },
      {
        "key": "repeat_count",
        "label": "执行次数",
        "type": "number",
        "default": 1,
        "min": 1,
        "max": 10,
        "step": 1
      },
      {
        "key": "mode",
        "label": "模式",
        "type": "select",
        "options": [
          { "value": "chat", "label": "聊天" },
          { "value": "command", "label": "命令" }
        ]
      }
    ]
  }
}
```

代码必须从平台注入的 JSON 读取变量：

```js
const variables = JSON.parse(process.env.BOT_PLATFORM_VARIABLES || '{}')
console.log(variables.join_message)
```

平台还会提供 `BOT_TEMPLATE_<大写_KEY>`，例如 `join_message` 对应 `BOT_TEMPLATE_JOIN_MESSAGE`。优先读取 `BOT_PLATFORM_VARIABLES`，因为它能保留数字和布尔类型。

变量会保存在平台数据库中，不应用于存放密码、Token、私钥等敏感凭据。

## 4. 计费模式

模板可由管理员配置为按小时或按次。代码可读取：

```js
const billingMode = process.env.BOT_PLATFORM_BILLING_MODE // hourly 或 once
const priceMomoc = Number(process.env.BOT_PLATFORM_PRICE_MOMOC || 0)
```

### 按小时

Bot 成功进入服务器后，平台每分钟实时扣除 `每小时价格 / 60`。按小时模板不需要、也不应该调用成功上报。

### 按次

按次模板必须在完整业务操作真正成功后调用：

```js
global.botPlatform.success('可选的成功说明')
```

硬性规则：

1. 不得仅因为 `login` 或 `spawn` 就上报成功，除非“成功进服”本身就是该模板出售的完整服务。
2. 必须等所有必要步骤完成并验证结果后再上报成功。
3. 同一次启动最多上报一次。重复上报不会重复扣费，但模板代码仍应避免重复调用。
4. 上报成功后平台会扣除一次费用，并自动结束本次进程。
5. 报错、掉线、主动退出或从未上报成功都不收费，也不会自动重试。
6. 启动时平台只预留费用；失败时释放，成功时才真正扣除。

### 定时运行

定时运行权限由管理员在模板设置中决定，并且只适用于按次模板。模板代码不得自行实现 `cron`、`setInterval` 无限循环或内部计划任务。平台每次触发计划都会启动一个新的独立进程；模板仍必须按上述规则在真正成功后调用一次 `global.botPlatform.success()`。如果对应 Microsoft 账号当时正被其他模板占用，本次计划会被平台跳过。

## 5. 错误与生命周期

### Zenox 聊天消息

平台会按照 cloud-store 对 `mc.zenoxs.cn` 的解析方式，同时处理标准聊天、私信、`messagestr`、`player_chat` 和 `system_chat`，并自动合并重复事件。模板不要只依赖 Mineflayer 的 `chat` 事件，应监听平台提供的标准化事件：

```js
bot.on('botPlatformMessage', event => {
  console.log(event.username, event.message, event.channel, event.source)
})
```

- `username`：发送消息的玩家。
- `message`：去掉服务器自定义聊天前缀后的正文。
- `channel`：`public` 或 `private`。
- `source`：原始 Mineflayer 或协议事件来源。

回复公屏使用 `bot.chat(text)`；回复私信应使用服务器对应的私信命令。

1. 使用 `bot.once('spawn', ...)` 作为进服后的业务入口。
2. 所有异步业务必须使用 `try/catch`，错误必须写入 `console.error`。
3. 按次任务失败时不得调用 `global.botPlatform.success()`；应设置非零退出码并结束连接。
4. 不要吞掉 `error`、`kicked` 和 `end` 事件中的关键错误。
5. 不要实现无限重连。按小时模板的进程重启由平台管理；按次模板失败后等待用户手动重试。
6. 不得修改平台 OAuth 缓存目录，不得读取其他 Bot 的目录或平台数据库。

推荐入口骨架：

```js
const mineflayer = require('mineflayer')

const variables = JSON.parse(process.env.BOT_PLATFORM_VARIABLES || '{}')
const options = {
  host: process.env.BOT_PLATFORM_SERVER_HOST,
  port: Number(process.env.BOT_PLATFORM_SERVER_PORT || 25565),
  username: process.env.BOT_PLATFORM_MICROSOFT_EMAIL,
  auth: 'microsoft',
  profilesFolder: process.env.BOT_PLATFORM_PROFILES_FOLDER
}

if (process.env.BOT_PLATFORM_MINECRAFT_VERSION) {
  options.version = process.env.BOT_PLATFORM_MINECRAFT_VERSION
}

const bot = mineflayer.createBot(options)

bot.once('spawn', async () => {
  try {
    // 在这里执行完整业务，并验证最终结果。
    if (variables.join_message) bot.chat(variables.join_message)

    if (process.env.BOT_PLATFORM_BILLING_MODE === 'once') {
      global.botPlatform.success('任务完成')
    }
  } catch (error) {
    console.error(error)
    process.exitCode = 1
    bot.quit('task failed')
  }
})

bot.on('kicked', reason => console.error('Kicked:', reason))
bot.on('error', error => console.error('Bot error:', error))
```

## 6. 交付检查

生成项目之前逐项确认：

- 输出的是完整项目及全部文件内容。
- `package.json` 可解析，入口文件存在，依赖完整。
- 只创建一个 Mineflayer Bot。
- 只使用 Microsoft OAuth2 和平台连接环境变量。
- 所有用户可调项均已声明为模板变量，没有业务参数硬编码。
- 变量类型、默认值和限制与代码读取方式一致。
- 按次模板只在业务真正成功后调用一次 `global.botPlatform.success()`。
- 失败路径绝不调用成功上报。
- 项目不包含账号、密码、Token、OAuth 缓存、数据库或 `node_modules`。
