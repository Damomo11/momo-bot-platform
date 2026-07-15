# Momo Bot Platform

独立的 Minecraft Bot 托管平台。用户先注册并登录网页，再使用 Microsoft OAuth2 设备码登录自己的 Minecraft Bot。每个 Bot 在独立子进程运行，和 `cloud-store` 没有数据库、配置、OAuth 缓存或进程依赖。

## 功能

- 用户注册和网页登录
- 管理员调整用户 momoc
- 每个模板独立配置按小时或按次价格
- 按小时模板每分钟实时扣费，页面统一显示 `momoc/1h`
- 按次模板仅在代码明确上报成功后扣费
- 用户可一次授权多个 Microsoft 账号，并在机器人配置中复用
- 同一个 Microsoft 账号任意时刻只能运行一个模板进程
- 管理员可决定按次模板是否允许用户设置定时计划
- 仅支持 Microsoft OAuth2 设备码登录，不保存密码
- 用户选择管理员上传的完整 Mineflayer 项目创建 Bot
- 管理员通过 ZIP 新增、替换、停用和删除完整项目模板
- 默认模板“仅登录挂机”可选配置进服消息，留空时只进入服务器
- 管理员可以查看和停止所有用户 Bot

## 启动

```powershell
npm install
$env:BOT_PLATFORM_ADMIN_PASSWORD='你的管理员密码'
npm start
```

默认地址：`http://127.0.0.1:8788/`

如果没有设置 `BOT_PLATFORM_ADMIN_PASSWORD`，首次启动会在终端打印随机管理员密码。首次管理员创建后，后续启动不会重置密码。

## 隔离目录

```text
data/bot-platform.sqlite   # 独立数据库
auth-cache/accounts/<id>/  # 每个 Microsoft 账号独立 OAuth 缓存
```

模板 ZIP 根目录必须包含 `package.json`，入口读取顺序为：

```text
package.json -> botPlatform.entry
package.json -> main
index.js
```

项目可以是普通、完整的 Mineflayer 项目，并自行调用 `mineflayer.createBot()`。平台通过 Node 预加载器注入用户选择的 Microsoft 邮箱、服务器地址、版本和独立 OAuth 缓存，同时监听 OAuth、登录、进服、掉线和错误事件。项目无需改写成函数或代码片段。

每个 Bot 会复制到 `runtime/<bot-id>/` 并作为独立 Node 子进程启动。模板由管理员维护，管理员应只上传可信项目。

## 模板变量

完整且可直接交给 AI 的模板开发硬性要求见 [`TEMPLATE_CONTRACT.md`](TEMPLATE_CONTRACT.md)，管理后台的代码模板页面也可直接查看和复制同一份内容。

模板可以在 `package.json` 中声明用户变量：

```json
{
  "botPlatform": {
    "entry": "index.js",
    "variables": [
      {
        "key": "join_message",
        "label": "进服消息",
        "type": "text",
        "default": "",
        "maxLength": 256
      }
    ]
  }
}
```

支持 `text`、`textarea`、`number`、`boolean` 和 `select`。模板项目可读取完整 JSON：

```js
const variables = JSON.parse(process.env.BOT_PLATFORM_VARIABLES || '{}')
console.log(variables.join_message)
```

平台也会为每个变量提供独立环境变量，例如 `join_message` 对应 `BOT_TEMPLATE_JOIN_MESSAGE`。变量修改会在 Bot 下次启动时生效。

## 模板计费

管理员在代码模板页面设置计费方式和价格：

- `按小时`：填写 `momoc / 1h`，平台每分钟实时扣除小时价格的 `1/60`。
- `按次`：填写 `momoc / 次`，模板未执行成功不收费。

按次模板必须在业务操作确认成功后调用：

```js
global.botPlatform.success('可选的成功说明')
```

每次启动最多扣费一次。成功后平台会结束本次运行；如果代码报错、掉线、退出或始终没有调用 `success()`，平台不会扣费，也不会自动重试。

允许定时运行由管理员在模板层控制，只适用于按次模板。用户可选择每 5 分钟、每 15 分钟、每小时、每 6 小时或每天固定时间执行。定时触发时如果 Microsoft 账号正被其他模板占用，本次运行会跳过。
