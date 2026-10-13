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

群聊读取服务端 `GROUP.md`，子话题仅读取自己的 `THREAD.md`。管理员或 bot 发出的更新/删除事件仅触发按真实会话 ID 重新查询；内容是否改变或删除以带鉴权的 GET 结果为准，不信任事件正文。每个 bot 的 LRU 缓存 30 秒过期，失败后 1 秒重试，连续事件合并到 1 秒的刷新间隔。群说明是转义后的 JSON 背景数据，不是系统指令，预算不足时整块丢弃，避免只剩无标签的正文。同一 SDK 会话只在内容或版本变化时注入，重试新会话时补全上下文；已确认的删除会明确撤销旧版本。本地 `groupConfigDir/<channelId>.md` 仍是独立的运维可信规则，不会上传到 Octo。

**核心特性:IM 会话与终端 codex 互通(opt-in)** —— bot 的每个会话对应一个 codex thread;开启共享后,你可以在终端 `codex exec resume <threadId>` 接续 bot 在群里的同一会话,反之亦然。

## 安装

```bash
npm install -g @mininglamp-oss/codex-channel-octo
```

依赖 `@openai/codex-sdk`,它会自带 codex 运行时(无需单独装 codex CLI)。需要 Node ≥ 22。

## 配置

服务器说明使用独立的 `[Server document — ...]` 数据标记，不复用伪造标记 `[Group context]` 或聊天记录标签。新会话的空文档不注入提示；仅对之前真正收到文档的续接 SDK 线程发送撤回，新线程重试不补入空文档。慢速刷新期间再次编辑时保留最后成功核验的快照，不静默丢弃。正文角色/章节标记被转义，VT/FF/NEL 转换为换行，这是有意的输入改写。

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

### Unicode JSONL 传输兼容

macOS/Linux 使用可执行代理，在 SDK 的 `readline` 读取之前将 CLI stdout 中的 U+2028/U+2029 转义。这两个字符在 JSON 字符串中合法，但 Node v24.10.0 将其视为行尾，可能拆坏合法事件，引发 `Failed to parse item` 并终止 SDK 子进程。转义不改变解码后的正文；代理保持 UTF-8 分块、stdin/stderr、背压和信号转发，并解析所安装 SDK 对应的 CLI 依赖。Windows 仍直接启动 SDK，此 Unix 方案不宣称解决 Windows 上的问题。

解析错误仅记录脱敏类别，不记录被拒绝的事件正文或子进程 stderr。已知线程最多续接一次，不确定的副作用禁止 fresh 重放；不静默丢弃事件。测试用真实 SDK 和合成 CLI 复现，无模型请求、网络请求或私有笔记读取。

代理缺失、不是普通文件或没有执行权限时，适配器只告警一次并提示 `npm run build`，退回直接 SDK 启动；退回模式不提供 Unicode 修复。`dev` 先构建/复制代理再启动 TypeScript watcher，修改 `.mjs` 后需重新 build；`prepack` 确保打包前构建。CI 验证包内执行权限，并在 Node 22/24.10.0 测试。入口解析失败只输出固定诊断，不泄露路径或 stderr；日志保留内置错误类别及白名单 OS/Node 错误码，不信任任意可改写的 name/code。

启动链增加两个 Node 进程；子进程未结束时仍转发可捕获信号，信号退出前刷新代理 stdout。SIGKILL 无法捕获，孤儿清理仍依赖外部监管。官方 CLI shim 保留自身环境设置，但 SDK 的 bundled PATH 注入被绕过；CLI 内部搜索会自行定位 rg，直接 shell 调用 rg 可能需要系统安装。

SDK override 使用私有可执行 shell 启动器，通过 `exec` 调用当前 Node 的绝对路径，不依赖 PATH 中存在 node；按代理路径缓存，正常进程退出时清理。显式取消后停止转发并独立排空子进程管道，不等待下游消费；1.5 秒后升级 SIGKILL，再设 0.5 秒退出上限。子进程自然信号退出仍刷新排队输出，但消费者已停止的取消路径允许丢弃输出。转换以有效 UTF-8 JSONL 为前提，不保证任意二进制透明传输。relay/router 同样使用脱敏摘要；包括恢复运行在内，SDK 解析错误不能成为失效线程的控制信号。代理恢复可用后再次丢失会重新告警。

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
npm run build       # 编译 TypeScript，并复制/设置 JSONL 代理执行权限
npm test            # vitest
npm run lint        # eslint --max-warnings 0
npm run type-check  # tsc --noEmit
```

## License

Apache-2.0
