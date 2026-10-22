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

适配器在每轮用户输入的独立元数据块中传递真实 `from_uid`、会话 ID/类型，以及按最新注册结果和当前传输空间匹配的 `is_owner`。同一身份快照随确认尚未执行时允许的重试传递，不重放执行状态不确定的任务，不写入共享 `AGENTS.md`；用户正文、引用和历史中的伪造身份标记会被转义。昵称和自称的 ID 不是认证依据，身份信息也不授予工具权限；敏感操作仍需宿主侧鉴权。绕过适配器的终端 resume 不具备可信 IM 发送者身份。

### 当前消息的 mention 信息

同一个适配器元数据块还包含 `message_id`、`bot_uid`、`mentioned_uids`、
`mention_source`、`is_explicitly_mentioned`、`mentioned_ais`、`mentioned_humans` 和
`mentioned_all`。信息来自清理正文之前的原始传输消息；每轮刷新，确认尚未执行时允许的重试复用
该轮快照，不重放执行状态不确定的任务。绕过适配器的终端调用默认 ID 为 null、UID 列表为空、source 为 `none`、标志为 false。

`is_explicitly_mentioned` 表示接收机器人的运行时 UID 精确出现在任一有效传输列表中。
渲染用的 `entities[].uid` 与路由用的 `uids` 是独立事实，会合并去重；渲染实体不必覆盖所有
被定向的账号。`mention_source` 为 `entities`、`uids`、`none` 或 `invalid`。广播标志只接受
`true` 或 `1`，不等同于明确 mention。正文中的 `@名字`、引用、历史、主人身份、免 @ 路由
和可信内部触发器都不能证明原始消息明确 @ 了机器人；这些字段不授予工具权限。

UID 必须为非空字符串，最多 256 个 UTF-16 code units，拒绝控制字符和行分隔符；不做 trim、
大小写或空间前缀归并。消息 ID 上限为 512。每个输入数组最多 128 项；畸形或超限数组单独
丢弃，保留有效的另一数组及严格广播标志。`invalid` 表示容器或数组被拒绝，不再意味着所有
独立事实均为 false。有效数组内的无效项会被忽略。机器人身份无效时明确 mention 为 false。

传给模型的 UID 快照最多 32 项，JSON 转义后 UTF-8 大小最多 4096 字节；发生省略时才输出
`mentioned_uids_truncated:true`。成员判断在快照截断前完成，被定向的接收机器人始终保留。
此限制约束新增元数据的放大；既有安全前缀和发送者框架仍在正文组装预算之外。

路由使用经验证的成员判断和严格 AI 标志，并兼容超限路由数组或旧版单字符串 UID 的精确匹配；该兼容判断不放宽提示元数据验证；单独的 `all` 或 `humans` 不触发机器人。无效群 mention
输出固定告警，仅使用限长后计算的会话/消息 SHA-256 关联值，不记录原始 ID 或正文。
正文截取另行校验 offset/length，支持 `@` 和全角 `＠`。广播 AI 消息不删除面向其他成员的开头 @；
entities 位置也阻止旧文本回退路径删除队友的 mention。容器或数组无效时保留正文，不猜测前缀。

发送者元数据的安全属性：

- 接受经校验的注册 UID 精确相等；为兼容裸注册 UID 与带前缀的传输 UID，也提供提示性前缀归属，候选前缀由完整主人 UID 推导。
- 推断前缀归属必须有可验证会话。先检查全部完整端点，再提取话题父群；DM UID 中的 `____` 保持不透明，空端点失败关闭。这是前缀兼容检查，不证明命名空间相等：含下划线的扩展空间可能共享前缀。宿主鉴权必须依据服务端完整传输身份或明确空间。
- 身份归属不改变 DM 会话键、SQLite SDK 映射、工作目录及记忆目录；保留该功能之前的路由解析。不剥离注册 UID，不做大小写、Unicode 或昵称归并。
- 元数据字段限长并保持单行 JSON；缺失身份输出空字段及 `is_owner:false`。身份始终位于背景和请求之前，覆盖初始、重试及恢复路径。
- 结构标记边界覆盖 Unicode 空白、格式字符（Cf）、非间距组合标记（Mn）及空白填充字符。VT/FF/NEL 转为换行，不宣称通用形近字符检测。完整锚点和截断提示计入字节预算，前截断丢弃转义残行；转义后的用户内容仍是不可信数据。
群聊读取服务端 `GROUP.md`，子话题仅读取自己的 `THREAD.md`。管理员或 bot 发出的更新/删除事件仅触发按真实会话 ID 重新查询；内容是否改变或删除以带鉴权的 GET 结果为准，不信任事件正文。每个 bot 的 LRU 缓存 30 秒过期，失败后 1 秒重试，连续事件合并到 1 秒的刷新间隔。群说明是转义后的 JSON 背景数据，不是系统指令，预算不足时整块丢弃，避免只剩无标签的正文。同一 SDK 会话只在内容或版本变化时注入，重试新会话时补全上下文；已确认的删除会明确撤销旧版本。本地 `groupConfigDir/<channelId>.md` 仍是独立的运维可信规则，不会上传到 Octo。

**核心特性:IM 会话与终端 codex 互通(opt-in)** —— bot 的每个会话对应一个 codex thread;开启共享后,你可以在终端 `codex exec resume <threadId>` 接续 bot 在群里的同一会话,反之亦然。

话题父群和复合 DM 端点通过 canonical parentGroupNo 及候选前缀验证，覆盖群/主人 UID 的下划线及两种端点顺序；仅使用传输元数据，不接受正文自称的 UID。提示标记分隔符使用带换行排除判断的单一正字符类，避免 BOM 的重叠分支导致普通文本指数回溯。

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

### 回复选择与长度上限

一轮 Codex 对话可能包含多条 agent 消息（例如调用工具前的过程说明和之后的回答）。Channel 每轮只选出**一条**回复，发给用户的内容和写入会话历史的内容完全相同。由 `sdk.outputSelection` 控制：

| 取值 | 行为 |
|---|---|
| `final`（默认） | 保留所有明确标记的最终回答；没有最终标记时只取最后一个非空、非 commentary 消息；只有 commentary 时取最后一个。属于顺序回退，不是识别出了模型意图。 |
| `phase`（兼容） | 运行时带有"最终回答"标记时只取该部分；否则保留全部非 commentary 消息，以空行分隔；仅有 commentary 时保留它们。**Codex SDK/CLI 0.142.3 不提供该标记，因此此模式下过程说明仍会被发送。** |
| `heuristic`（需显式开启） | 只保留本轮最后一次工具调用 / 命令 / 文件修改之后的消息；本轮未正常结束或会丢弃较长的前序消息时，回退为发送全部消息。这是基于顺序的启发式，并非最终回答信号。 |
| `legacy`（回滚） | 旧行为：最后一次运行的全部消息直接拼接，不加分隔。 |

**默认行为变更：** 未设置 `sdk.outputSelection` 时现在使用 `final`。显式设置的 `phase`、`heuristic`、`legacy` 保持原行为。Codex exec JSONL 0.142.3/0.162.1 不输出 phase，因此默认日志通常为 `source=last_message`。不再按前文长度恢复并拼接消息。没有标记的多段回答可能丢失前段（包括末条只是简短结束语的情况）；需要保留它们时显式选择 `phase`。有明确标记的多段最终回答仍全部保留。同一 item 的快照覆盖不改变首次出现顺序，空白消息不会覆盖有效回答。中断或恢复继承的回退记录为 `last_message_partial`，不能据此声称任务完成。详见[源码分析和策略说明](docs/final-output-policy.md)。

流中断恢复后若恢复运行没有产生消息，会改用被中断那次运行的消息，其中可能包含过程说明。

`maxResponseChars`（默认 `524288`）限制回复长度。超长回复会被截断，保证发送内容（含末尾 `[response truncated]` 提示）不超过该上限，历史记录按同样规则截断。1–44 的上限截断时不附加提示，启动时会打印一条警告。**非整数和非正数会被拒绝；所有正整数仍然支持。** 启动时遇到非法值会直接报错退出；热重载时记录日志并忽略，正在运行的 bot 不受影响。

两项设置都在 bot 启动时生效。修改后需重启进程，或以新 id 重新添加该 bot。热重载只会按 id 增删 bot。

### Card configuration (startup only)

The closed `cards` object accepts `disable: false|true` (boolean, default
`false`), `eventTransport: "off"|"short"|"long"` (default `"off"`) and
`reasoningSummary: "off"|"on"|"stream"` (default `"off"`). `disable=true` is a
local narrowing kill switch; `false` grants nothing. Transport and summary
preferences cannot authorize intake or reasoning content. Configuration does
not prove server policy, routing authority, topology authorization, source/privacy
acceptance, R03/S05 or production use.

Merge precedence is global → inline `bots[]` entry → `<id>/config.json`.
Explicit fields override individually; omitted fields inherit, then defaults
fill remaining omissions. Empty `cards: {}` inherits everything. Each bot gets
a separate frozen startup snapshot. Null, arrays, wrong booleans/enums and
unknown keys (including `_comment` inside `cards`) fail startup without
coercion, even when a higher layer would replace the invalid value. Diagnostics
omit supplied keys/values, credentials, Bot ids and paths.

The existing watcher reconciles IDs only. Same-ID edits do not restart a bot or
change its snapshot. An actual process/Bot restart or explicit removal followed
by re-addition gets fresh settings. Invalid edits keep the running set intact;
this is not a watcher, hot-reload or platform stability guarantee.

Deprecated top-level `cardProgress`, `reasoningCardTemplateMode`, `cardDisplay`,
`cardInteraction`, `OCTO_CARD_MESSAGE_ENABLED` and `OCTO_CARD_MERGE_FINAL` are
ignored; the two `OCTO_` environment names are ignored too. At most one fixed,
value-free warning per key is emitted per process. Generic `sdk.env` forwarding
is unchanged and cannot alter canonical cards. No runtime card wiring, intake,
summary delivery or production enablement is added. See the English README's
card configuration table and the canonical examples for details.

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

### 私密 MEMORY.md（默认关闭）

将人工维护的 `MEMORY.md` 放在 `<baseDir>/<botId>/SOUL.md` 同级目录，在全局或单 bot 配置中设置 `"privateMemory": { "enabled": true, "maxBytes": 16384 }`。单 bot 字段覆盖 inline/global 字段；`maxBytes` 必须是 1～65536 的整数。配置变化需重启，文件修改或删除在下一次符合条件的请求中重新读取。

仅当传输层明确为 DM，且发送者 UID 精确匹配**最近一次成功注册**信息的 `owner_uid` 时读取。群、话题、非主人及未知身份不读取该文件。快照作为有大小限制的非可信 JSON 背景注入每次符合条件的 SDK 调用，包括允许的执行前重试；不确定的断流或失效线程不自动重放，遵循安全恢复策略。不写入共享 `AGENTS.md`。缺失或无法读取时发送背景状态而非报错阻止回复；拒绝文件符号链接和非普通文件。当前阶段不加载 `memory/` 日记、不提供搜索或写入、不实现压缩钩子；续接线程中暂不去重快照。

启用后普通会话和私密记忆会话使用不同命名空间的历史、SDK 线程和工作目录。启用/关闭会使所有会话（包括群和非主人 DM）切换历史、工作目录及 SDK 线程作用域，按会话连续性重置安排上线，但不删除旧记录；成功重新注册并观察到主人变化后，原主人才会进入普通作用域，不再复用先前的私密线程。`/reset` 只重置当前作用域，不删除 `MEMORY.md`。

**转让机器人：**健康心跳不会重新注册或刷新主人信息，因此本功能不提供实时撤权；缓存的注册信息仍指向原主人期间，原主人仍符合读取条件。转让前先停止并排空机器人，重新启动、确认按新主人注册成功后，再恢复流量或修改私密笔记。仅 WebSocket 重连不保证重新注册；成功的注册刷新（包括 token 刷新）也会更新主人快照。测试验证这一注册来源和消费边界，不宣称能即时感知服务端转让。

拒绝群组或其他用户可写的文件（`mode & 0022`），建议使用操作者拥有的 `0600` 权限保护机密性。非 ENOENT 错误仅记录固定诊断码和安全 bot 标签，不记录路径、正文或原始异常。即使截断前缀只有空白或不完整 UTF-8 字符，也会标为可用而非文件缺失。仅拒绝最后一级文件符号链接；父目录符号链接与硬链接不构成路径包含性保证，目录树仍需外部保护。

**边界说明：**这是适配器注入过滤，不是文件系统权限控制。`read-only` 不一定禁止读取 cwd 以外的文件，`danger-full-access` 更不提供隔离；同一系统用户下的工具还可以覆盖 `0600` 笔记，JSON 转义不会保证笔记事实可信；对不可信用户必须另有容器/文件权限边界。不要跨不相关用户共享个人 Codex home，SDK 的历史存储不在本功能保护范围内。

### 安全恢复与执行隔离

中断处理函数退出且网关确认受管理执行已停止后，可以发送新请求，保留失败上下文但不自动重放旧任务；清理期间新请求排队。缺少停止证据、历史或崩溃隔离仍保留维护保护，重启和 reset 不会解除；SDK 尚未启动即取消则保持 clean。详见[会话连续性](docs/session-continuity.md)。
自动重试默认关闭，只覆盖能证明尚未执行的暂时性故障。核对外部结果后，来信 UID
**与注册 owner_uid 精确相同**的主人可发送：

```text
/reconcile TURN_ID --external-results-verified
/reconcile TURN_ID --session SESSION_KEY --external-results-verified
```

指定目标须从主人的本人私聊发送；编号、目标及旧本地任务状态仍需核对。恢复不会
重放、重发或清除历史；成功和拒绝都有仅含身份哈希与固定结果类别的审计记录。

**通道改写主人 UID 时必须离线维护。** 当前 API 的 owner_channel_id 就是 owner_uid，
不提供可信空间映射，不能凭来信 UID 后缀授权。启动日志及暂停提示会明确说明：
若来信是不同的前缀 UID，维护者须核对效果、停止网关并使用[离线工具](docs/issue-26-safe-recovery.md)，
可能中断 supervisor 中的其他机器人。注册 UID 本身已带前缀时，精确匹配仍可在线恢复。
prompt 的 is_owner 仅作归属提示，不能授权控制命令。

quarantined 流量有独立总限额并保留个人/会话限额，不挤占健康模型请求，也不无限
放行不同发送者；active 记录仍使用正常限额。暂停期间普通群消息继续进入有界缓存，
控制命令不进入。默认超时 300 秒可为长任务调整，但不能据此豁免执行核对。

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
npm ci              # 按仓库锁文件安装
npm run runtime:update  # 显式升级 SDK 及配套 CLI 到最新稳定版
npm run build       # 编译 TypeScript，并复制/设置 JSONL 代理执行权限
npm test            # vitest
npm run lint        # eslint --max-warnings 0
npm run type-check  # tsc --noEmit
```

### 本机运维诊断（默认关闭）

设置 `sdk.privateDiagnostics: true` 可保存与任务编号关联的本机失败元数据。SDK 错误文本只保留指纹，不写入原文；公开回复不变。日志仅当前用户可读，最多保留三个文件，每个不超过 1 MiB。详见[隐私边界、保留策略与解读](docs/private-diagnostics.md)。

### Codex 运行时版本

全新安装已发布的适配器时，SDK 通过 npm 的稳定版 `latest` 标签解析；CLI 使用 SDK 声明的配套版本，不使用无关的全局 `codex`。仓库锁文件保留已测试版本，供 `npm ci` 可复现构建。存在锁文件时，即使执行 `npm install`，也可能继续使用旧运行时。

在源码或打包暂存目录中显式刷新版本，再验证和打包：

```bash
npm ci
npm run runtime:update
npm run build
npm test
npm pack
```

`runtime:update` 执行 `npm update @openai/codex-sdk`，更新锁文件并保留 `latest` 依赖标签，然后运行 `runtime:check`。后者从已安装的 SDK 解析 CLI，实际启动 `--version`，报告 SDK、CLI 包与原生二进制版本，缺失或不匹配时失败；不调用模型、不要求登录。不要复制旧 node_modules 后就认为版本已升级。更新命令会修改依赖，应在暂存目录验证后再部署，它不会重启网关。

CI 在 Node 22/24 上同时验证锁定版本及重新解析的最新稳定版，包括严格类型、实际 CLI 启动、SDK/代理/进程回归和打包检查。未来新版需要通过兼容测试；更新失败必须明确报告，不得静默回退并声称升级成功。需要复现旧版本时使用对应发布版本的锁文件，不要独立覆盖 SDK 选用的 CLI。

## License

Apache-2.0

详细诊断需同时开启 `sdk.privateDiagnostics` 与 `sdk.privateDiagnosticsDetails`（默认均关闭），仅保存有界白名单元数据，不保留任意错误原文。写入器要求预先存在的本地数据目录及 POSIX 防跟随、目录和非阻塞打开标志；拒绝符号链接祖先、硬链接和组/其他用户可读文件。缺少必要标志时拒绝创建文件。原生 Windows 与网络/FUSE 文件系统兼容性尚未验证。详见[本机诊断](docs/private-diagnostics.md)。

路由兼容只接受目标 UID 完全匹配，不进行子串匹配；拒绝的元数据仍为 `invalid`。首位属于其他成员的渲染实体会保留，仅后续位置有实体时可移除首位机器人 mention。

## 源码测试工具

隔离配置、生命周期控制、抓取与回读以及验证命令，参见[隔离测试配置与抓取说明](docs/isolated-test-profiles.md)（英文）。这些测试辅助工具不包含在 npm 安装包中。
