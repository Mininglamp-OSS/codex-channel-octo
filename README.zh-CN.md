<h1 align="center">codex-channel-octo</h1>

<p align="center">
  把 <a href="https://developers.openai.com/codex">OpenAI Codex</a>(经 <a href="https://www.npmjs.com/package/@openai/codex-sdk"><code>@openai/codex-sdk</code></a>)接成 <a href="https://github.com/nicco-io/octo">Octo</a> IM 机器人的独立 Node.js 网关。
</p>

<p align="center">
  <a href="https://github.com/Mininglamp-OSS/codex-channel-octo/actions"><img src="https://github.com/Mininglamp-OSS/codex-channel-octo/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node.js version">
  <img src="https://img.shields.io/badge/status-early%20test-orange" alt="Status: early test">
</p>

<p align="center">
  <a href="./README.md">English</a> · <b>简体中文</b>
</p>

---

> ⚠️ **早期测试版(v0.1.0)。** 主链路(注册 / 连接 / 多轮对话 / 多 bot)已验证可用,但仍在完善中。**已知缺口**:暂无定时任务(cron)、暂无 skills——见 [CHANGELOG](./CHANGELOG.md)。与姊妹仓库 [`cc-channel-octo`](https://github.com/Mininglamp-OSS/cc-channel-octo)(Claude Code 版)同形态,内核换成 Codex。

## 是什么

一个常驻进程:注册成 Octo bot → 连 WebSocket 收消息 → 用本地 Codex 跑编码任务 → 把结果回帖。支持 DM / 群(@提及)/ 子话题、多轮对话、多 bot 单进程、配置热重载。

**核心特性:IM 会话与终端 codex 互通(opt-in)** —— bot 的每个会话对应一个 codex thread;开启共享后,你可以在终端 `codex exec resume <threadId>` 接续 bot 在群里的同一会话,反之亦然。

## 安装

```bash
npm install -g @mininglamp-oss/codex-channel-octo
```

依赖 `@openai/codex-sdk`,它会自带 codex 运行时(无需单独装 codex CLI)。需要 Node ≥ 22。

## 配置

两层配置,bot-first:

- **全局** `~/.codex-channel-octo/config.json` —— 共享默认 + `bots` 列表,**不含 token**。见 [`config.example.json`](./config.example.json)。
- **每 bot** `~/.codex-channel-octo/<id>/config.json` —— 该 bot 的 `botToken` + 覆盖项。见 [`config.bot.example.json`](./config.bot.example.json)。每个 bot 是自包含子树:`<baseDir>/<id>/{config.json, SOUL.md, data/, workspace/, codex-home/}`。

最小例子:

```jsonc
// ~/.codex-channel-octo/config.json
{ "apiUrl": "https://your-octo-instance.com", "bots": [{ "id": "default" }] }
// ~/.codex-channel-octo/default/config.json
{ "botToken": "bf_YOUR_BOT_TOKEN" }
```

### Codex 鉴权

每个 bot 默认有独立的 `CODEX_HOME`(`<id>/codex-home`),需各自鉴权,二选一:

1. `CODEX_HOME=~/.codex-channel-octo/default/codex-home codex login`
2. 在 per-bot config 里设 `sdk.codexApiKey`(+ 必要时 `sdk.codexBaseUrl`)。

> 未鉴权的独立 home 会回退到 `api.openai.com` 并 401。

### 群和话题的免 @ 回复

支持前端「免@回答」页面中的逐群开关，无需手动修改 Channel 配置。
群内开启后普通消息可触发回复；关闭后恢复为需要 @（本地显式覆盖除外）。

收到未 @ Bot 的群或话题消息时，Channel 会查询
`GET /v1/bot/groups/{父群ID}/mention_pref`，按服务端的 `effective` 判定是否免 @，
包括 AI 私人会话。话题继承父群设置，聊天历史仍按话题分别保存。

自动免 @ 只放行服务端明确标记为真人的群成员；其他 Bot 仍需 @，除非已列入
`allowedBotUids`。接口失败或成员身份不明时，继续要求 @。设置及成员身份按 Bot、
父群缓存 30 秒，收到 `mention_pref_updated` 事件后清除对应父群缓存。

已有 `mentionFreeGroups` 仍是按完整频道 ID 精确匹配的本地显式覆盖。
服务端已允许免 @ 的 AI 会话不需要逐个填写话题 ID。

## 运行

```bash
codex-channel-octo start        # 后台启动(supervisor)
codex-channel-octo status       # 查看状态
codex-channel-octo stop         # 优雅停止
npm start                       # 前台运行(调试)
```

## 安全模型

IM 输入是**不可信**的,权限边界是 **sandbox**,不是 prompt:

- **`sandboxMode` 默认 `read-only`** —— 首版定位安全问答 / 代码审阅。要让 bot 改文件,须**同时**设 `allowWorkspaceWrite: true` 和 `sandboxMode: "workspace-write"`(双开关防误配)。
- **`sdk.additionalDirectories`** —— 每会话 cwd 之外的额外**可写**根(如共享 work bus)。仅在 `workspace-write` 下附加(`read-only` 下无意义故省略;AGENTS.md 写失败强制降级时一并清除)。条目必须是**绝对路径**(不含 `~`/相对路径/`..`),且启动时会拒绝任何**包含、等于或位于**受信任 / 敏感目录之内的条目 —— 会话 cwd、config/SOUL 树、`groupConfigDir`、memory 目录、`codexHome` —— 使可写根永远不会与"确立 agent 信任边界的文件"重叠。
- 显式设置 `sdk.sandboxMode: "danger-full-access"` 可关闭 Codex 沙箱，由容器或宿主环境承担隔离。命令按运行用户权限访问容器文件及挂载目录，工作区和敏感子目录的写保护不再生效。
- `networkAccessEnabled` / `webSearchEnabled` 默认关。`danger-full-access` 下网络不受 Codex 限制，`networkAccessEnabled: false` 无法阻断网络；`/config` 会显示这一实际状态。
- 安全前缀(防注入)写入每会话沙箱的 `AGENTS.md` 并在 prompt 顶部重申(纵深防御,但仅软约束)。
- 每 bot 独立 `CODEX_HOME`,IM 内容默认不落入个人 `~/.codex`。

### Docker 专用配置

在专用 Docker 容器中，可使用 [`config.bot.docker.example.json`](./config.bot.docker.example.json) 作为该 bot 的配置，默认选择 `danger-full-access`。已有配置只需在 `sdk` 内设置：

```json
{ "sdk": { "sandboxMode": "danger-full-access" } }
```

此模式不需要 `allowWorkspaceWrite` 或额外的网络开关。修改后重启 Channel，发送 `/config` 确认模式。预计 Docker 默认 seccomp 即可运行，无需添加 `privileged`、`SYS_ADMIN` 或自定义 seccomp；这一点尚未在真实容器中验证。宿主机与容器自身的访问限制仍然适用。

程序默认仍是 `read-only`，不会根据 Docker 检测结果自动变更权限。每个信任边界使用独立容器，避免挂载宿主凭据或 Docker socket。关闭 Codex 沙箱后，同一容器中的不同 bot 不再由 Codex 提供文件访问隔离。若本轮 `AGENTS.md` 无法更新，会停止该轮并报告错误。

## IM ↔ 终端互通(opt-in)

默认隔离。要开启互通,把 per-bot 的 `sdk.codexHome` 指向你的个人 `~/.codex`:

```jsonc
{ "botToken": "bf_...", "sdk": { "codexHome": "/Users/you/.codex" } }
```

此后 bot 在群里的会话可在你终端 `codex exec resume <threadId>` 接续。**注意:IM 内容会进入你个人的 codex 会话历史。**

## 与 Codex 的差异(对比 Claude 版)

| | cc-channel-octo | codex-channel-octo |
|---|---|---|
| 内核 | `@anthropic-ai/claude-agent-sdk`(in-process) | `@openai/codex-sdk`(spawn 本地 codex) |
| 会话 | SDK session id | codex thread id(存 `~/.codex/sessions`,可终端接续) |
| 流式 | 逐 chunk | 最终消息整段投递 + 中间步骤作进度 |
| 权限 | permissionMode / allowedTools | sandboxMode / approvalPolicy |
| 系统提示 | SDK preset + append | 会话沙箱 `AGENTS.md` |

## 开发

```bash
npm install
npm run build       # tsc → dist/
npm test            # vitest
npm run lint        # eslint --max-warnings 0
npm run type-check  # tsc --noEmit
```

## License

Apache-2.0
