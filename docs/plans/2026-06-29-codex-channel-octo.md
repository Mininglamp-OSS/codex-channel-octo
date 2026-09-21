# codex-channel-octo 实现计划

> 把 OpenAI Codex 接成 octo IM bot。形态完全对标 `cc-channel-octo`(独立 Node gateway),唯一内核差异:agent 从 `@anthropic-ai/claude-agent-sdk` 换成 `@openai/codex-sdk`。

## 1. 背景与目标

### 1.1 目标
新建 `codex-channel-octo` 仓库:一个独立的 Node.js 进程,把本地 Codex(经 `@openai/codex-sdk`)桥接到 octo IM,使其成为一个可多轮对话、可执行编码任务的 bot。

### 1.2 已验证的关键事实(spike 实测,2026-06-29)
- `@openai/codex-sdk@0.142.3` **bundle 了 codex binary**(依赖 `@openai/codex` + 平台包),装 SDK 自带 codex,不依赖系统 codex。
- API:`new Codex(opts)` → `startThread(ThreadOptions)` / `resumeThread(id, ThreadOptions)` → `thread.runStreamed(input) → {events: AsyncGenerator<ThreadEvent>}` / `thread.run(input) → Turn`。`thread.id` 首 turn 后即为 threadId。
- ✅ threadId 可取、resumeThread 上下文延续成功、终端系统 codex 0.139.0 能 resume SDK 0.142.3 创建的 session(共享 `~/.codex/sessions/`)。**这是核心差异化卖点:IM 会话与终端 codex 互通。**
- ⚠️ **流式粒度**:codex 的 `agent_message`(最终回复)是**一次性完整投递**(单 `item.completed`,无逐字增量)。中间过程(command_execution / reasoning / file_change / todo_list / web_search)是独立 `item.completed`,可作进度提示。
- 坑:`modelReasoningEffort:"minimal"` 与 web_search 冲突 → 默认显式关 web_search 或 effort≥low。
- 本机 provider=`deepminer`, model=`gpt-5.5`(自建 provider,非 openai 官方,配置须可指定 baseUrl/apiKey/env)。

### 1.3 设计契合点(为何能大量照搬 cc)
- **cc 的 stream-relay 本质是 accumulate-then-send**(累积所有 chunk + typing 心跳,最后一次分段发),并非逐字打字机。→ codex 的"agent_message 一次性投递"与该模型天然契合,**stream-relay 几乎零改动**。
- **cc 的 session-store `sdk_sessions` 表**(`sdk_session_id` 字段)正好用来存 codex threadId,接口 `get/set/clearSdkSessionId` 名称保留,**零改动**。
- **cc 的 onToolUse 回调机制**(tool progress)正好用来承接 codex 中间 item 事件。

## 2. 范围

### 2.1 In scope
1. 新仓库骨架 + package.json(依赖换 codex-sdk,bin `codex-channel-octo`)。
2. octo 协议层(api/socket/types)照搬 + 改 agentPlatform 字符串。
3. `agent-bridge.ts` 改写:核心,Claude SDK → codex SDK,保留 stale-resume 恢复 / 流式 / tool-progress / prompt 注入安全。
4. `config.ts` schema:sdk.* 字段映射成 codex 维度(sandboxMode/approvalPolicy/modelReasoningEffort/workingDirectory/codexApiKey/codexBaseUrl 等)。
5. 其余纯 IM 逻辑文件照搬(见 §4 清单)。
6. CLI supervisor / configure / 包名字符串本地化。
7. 单元测试(TDD)+ 本地联调(localhost:3000)。

### 2.2 Out of scope(本次不做,留后续)
- runtime 侧复活 codex(daemon adapter / fleet provider active)——**这是独立工作**,本仓库先做成可独立 `npm start` 跑通的 gateway;daemon 集成单开 PR。
- cron 工具(`cron-*`、`cron-tool.ts`):codex SDK 的 MCP 注入机制与 Claude 不同,首版**关闭 cron**(config 里 `cron:false` 且不注入),留 v2。先确保主链路通。
- skill-linker:codex 的 skill 发现机制与 Claude `.claude/skills/` 不同,首版**不做 skill 注入**,留 v2。
- npm 发布 / provenance。

## 3. 架构决策记录(brainstorming 结论)

| 决策 | 选择 | 理由 |
|---|---|---|
| 形态 | 独立 Node gateway(仿 cc) | codex 无 plugin 宿主;cc 骨架成熟可复用 |
| agent 内核 | `@openai/codex-sdk`(非自己 spawn) | spike 验证 SDK 封装好 threadId/流式/进程管理,抗 flag 漂移;底层同样是本地 codex |
| 流式策略 | 中间 item → onToolUse 进度;最终 agent_message → 作为 chunk(s) 走 stream-relay | 契合 codex 一次性投递 + cc accumulate-then-send 模型 |
| threadId 存储 | 复用 `sdk_sessions` 表 | 字段语义兼容,零 schema 改动 |
| cron / skills | 首版关闭 | codex 注入机制不同,降低首版风险,留 v2 |
| 配置目录 | `~/.codex-channel-octo/<botId>/` | 与 cc 隔离,同结构 |
| provider 配置 | 支持 codexApiKey / codexBaseUrl / env 透传 | 适配自建 provider(deepminer) |

## 4. 文件改动清单

### 4.1 原样照搬(零 agent 耦合,纯 IM/octo 逻辑)
`src/octo/socket.ts`、`src/octo/types.ts`、`src/session-router.ts`、`src/group-context.ts`、`src/cwd-resolver.ts`、`src/prompt-safety.ts`、`src/mention-utils.ts`、`src/url-policy.ts`、`src/inbound.ts`、`src/media-inbound.ts`、`src/file-inline-wrap.ts`、`src/stream-relay.ts`、`src/group-config.ts`、`src/db-adapter.ts`、`src/session-store.ts`、`src/bot-manager.ts`、`src/config-watcher.ts`、`src/cron-fire-marker.ts`

> 照搬时仅把日志前缀 `[cc-channel-octo]` → `[codex-channel-octo]`(grep 批量替换,非逻辑改动)。
>
> **保留 `cron-fire-marker.ts`**:`session-router.ts` 直接 `import isAuthenticCronFire from './cron-fire-marker.js'` 做 cron 真伪校验 + @mention/rate-limit bypass(`session-router.ts:9,334,381,409`)。该文件只是无调度副作用的 payload nonce 校验(几十行),保留它 → session-router 可零改动照搬。砍掉它则要同时删 session-router 的 isCronFire 三处逻辑 + 改测试,得不偿失。首版没有 cron 调度器,自然不会有真 cron fire 进来,该校验恒返 false,无害。

### 4.2 不照搬(首版砍掉)
`src/cron-evaluator.ts`、`src/cron-scheduler.ts`、`src/cron-store.ts`、`src/cron-tool.ts`、`src/skill-linker.ts` — 留 v2。需在 agent-bridge / index.ts / config.ts 里去掉对它们的引用。(注意:`cron-fire-marker.ts` **不在**此列,见 §4.1。)

### 4.3 改写

**`src/octo/api.ts`**(1 处)
- `registerBot` 里 `agentPlatform: 'cc-channel-octo'` → `'codex-channel-octo'`。其余 REST 函数零改动。

**`src/commands.ts`**(`/config` 输出)
- `commands.ts:79-86` 直接读 `config.sdk.allowedTools` / `config.sdk.permissionMode` 打印——这俩字段在 §5 被删/改名,照搬会编译失败。`/config` 输出改成 codex 字段:`model` / `approvalPolicy` / `sandboxMode` / `modelReasoningEffort` / `networkAccessEnabled` / `webSearchEnabled` / `toolProgress`。`/reset`/`/help` 零改动。迁移并更新对应测试。

**`src/gateway.ts`**(1 处)
- register() 里传 `agentPlatform: 'codex-channel-octo'`,`agentVersion: PKG_VERSION` 保留。

**`src/config.ts`**
- `DEFAULT_CONFIG_PATH`:`.cc-channel-octo` → `.codex-channel-octo`。
- `sdk` 块字段映射(见 §5)。删 `anthropicBaseUrl`/`apiKey`,加 codex 维度。
- 去掉 cron/skills 相关字段(或保留 `cron:false` 占位但不接线)。

**`src/agent-bridge.ts`**(核心,见 §6 详设)
- import 换 codex-sdk。
- `buildSdkEnv`:`ANTHROPIC_*` → codex provider env(`codexApiKey`/`codexBaseUrl`/`env` 透传)。
- `queryAgent` 重写:用 `Codex` + `startThread`/`resumeThread` + `runStreamed`,消费 `ThreadEvent` 流,中间 item → onToolUse,agent_message → yield,threadId → onSessionId,stale-resume 恢复保留。
- 删 Claude preset systemPrompt / settingSources / memoryDir / mcpServers(skills/cron 入参)。systemPrompt 改用 codex 的注入方式(见 §6.4)。

**`src/index.ts`**
- 顶部注释/描述本地化。
- 去掉 cron / skill-linker / memoryDir 相关代码段。
- queryAgent 调用接缝保持(输入 userContentForLLM、消费 teeChunks、onSessionId 持久化、fallbackRetryPrompt)——这套契约不变。

**`src/cli.ts` / `src/configure.ts`**
- 包名/命令名字符串 `cc-channel-octo` → `codex-channel-octo`。
- configure 里 API key 提示语本地化(codex provider)。
- upgrade 子命令的 npm 包名(留占位,首版不发布可 no-op 或指向本地)。

**`package.json` / `tsconfig.json` / README / config 示例**
- name `@mininglamp-oss/codex-channel-octo`,bin `codex-channel-octo`。
- deps:删 `@anthropic-ai/claude-agent-sdk`,加 `@openai/codex-sdk`。
- config.example / config.bot.example 更新为 codex 字段。

## 5. Config schema 映射(sdk.*)

| cc 字段 | codex 字段 | 处理 |
|---|---|---|
| `model` | `model` | 保留,默认改(留空→codex 默认,或 `gpt-5.5`) |
| `allowedTools` | (删) | codex 无等价细粒度白名单;改用 sandboxMode/approvalPolicy 控权 |
| `permissionMode` | `approvalPolicy` | `never`/`on-request`/`on-failure`/`untrusted`,默认 `never`(headless,无人审批)。**注意**:headless 下 approval 无人应答,真正的权限边界是 `sandboxMode`,不是 approval。 |
| `maxTurns` | (删) | codex SDK 无此选项 |
| `systemPrompt` | `systemPrompt`(经 base-instructions / prompt 前缀) | 见 §6.4 |
| `settingSources` | (删) | Claude 专有 |
| `toolProgress` | `toolProgress` | 保留,控制是否推中间 item(脱敏后,见 §6.6) |
| `anthropicBaseUrl` | `codexBaseUrl` | → `new Codex({baseUrl})` 或 env |
| `apiKey` | `codexApiKey` | → `new Codex({apiKey})` 或 env |
| `env` | `env` | 透传给 codex 进程(自建 provider 需要) |
| (新增) | `sandboxMode` | `read-only`/`workspace-write`/`danger-full-access`,**默认 `read-only`**(见下 C5 决策);显式 `danger-full-access` 关闭 Codex 沙箱,由容器/宿主承担隔离 |
| (新增) | `codexHome` | 每 bot 独立 CODEX_HOME(见 §9 R6),默认 `<baseDir>/<botId>/codex-home`;不与个人 `~/.codex` 共享 |
| (新增) | `allowWorkspaceWrite` | bool,默认 false。为 true 才允许 `sandboxMode:workspace-write` 生效;否则即使配了也降级 read-only |
| (新增) | `modelReasoningEffort` | `minimal`..`xhigh`,默认 `medium` |
| (新增) | `networkAccessEnabled` | 默认 false |
| (新增) | `webSearchEnabled`/`webSearchMode` | 默认 false/disabled(避免与 minimal effort 冲突) |
| `cron`/`skills` | (删,v2) | — |

> **C5 安全决策(2026-09-21 更新)**:IM 是不可信输入,安全 prompt 前缀**不是**可靠权限边界(模型可能被绕过)。默认边界是 Codex sandbox;显式关闭后由容器/宿主承担隔离。因此:
> - **默认 `sandboxMode: read-only`** —— 首版定位是"安全问答 / 代码审阅 / 解释"为主,默认不让任意 IM 用户驱动 bot 写本地文件。
> - 想让 bot 能改代码 → 运维显式配 `allowWorkspaceWrite: true` + `sandboxMode: workspace-write`,**二者同时满足**才放行(双开关,防误配)。建议同时配 owner/channel 白名单(v2 强化)。
> - 运维可显式设置 `danger-full-access`,不需要 `allowWorkspaceWrite`。此模式按运行用户权限访问文件和网络,Codex 不限制工作区、敏感子目录或不同 bot 之间的文件访问;每个信任边界须有独立容器/宿主隔离。
> - `workspace-write` 锚在每会话 cwd 及显式额外可写目录;`danger-full-access` 没有此写保护,`networkAccessEnabled:false` 也不能阻断网络。
> - 若本轮 `AGENTS.md` 刷新失败,`danger-full-access` 在执行前终止该轮;其他模式降级 `read-only` 并清除额外可写目录。指令刷新不是隔离边界。

## 6. agent-bridge 详细设计(TDD 核心)

### 6.1 入口签名(对外契约不变)
保持 `queryAgent(userMessage, config, sessionCtx?, onToolUse?, opts?) → AsyncIterable<string>`,`opts` 保留 `{ resume?, onSessionId?, onResumeFailed?, fallbackRetryPrompt? }`(删 groupInstructions 用法改为并入 systemPrompt、删 memoryDir/mcpServers)。这样 index.ts 接缝几乎不动。

### 6.2 Codex 实例与 thread
```
const codex = new Codex({ ...(codexApiKey?{apiKey}:{}) , ...(codexBaseUrl?{baseUrl}:{}),
  env: buildCodexEnv(config.sdk, process.env) });   // env 含 CODEX_HOME=codexHome(每 bot 独立, R6)
// workspace-write 需 allowWorkspaceWrite;显式 danger-full-access 由容器/宿主隔离
const effectiveSandbox = resolveSandbox(config.sdk);  // 见 §5 C5 决策
// network/webSearch 从 config 解析(默认 false/disabled),不硬编码——否则 config 字段变无效字段(C8)
const effNetwork = effectiveSandbox === 'danger-full-access' || (config.sdk.networkAccessEnabled ?? false);
const effWebSearch = config.sdk.webSearchEnabled ?? false;
const effWebSearchMode = effWebSearch ? (config.sdk.webSearchMode ?? 'live') : 'disabled';
const threadOpts = { workingDirectory: cwd, skipGitRepoCheck: true,
  sandboxMode: effectiveSandbox, approvalPolicy, modelReasoningEffort, model,
  networkAccessEnabled: effNetwork, webSearchEnabled: effWebSearch, webSearchMode: effWebSearchMode };
const thread = resumeId ? codex.resumeThread(resumeId, threadOpts) : codex.startThread(threadOpts);
const { events } = await thread.runStreamed(promptText);
```
> `CODEX_HOME` 经 env 注入 codex 子进程(SDK `env` 选项),使每 bot 的会话/auth/config/memory 落在独立目录,不与个人 `~/.codex` 混。互通(共享 `~/.codex`)改为显式 opt-in(配 `codexHome: "~/.codex"`)。见 §9 R6。

### 6.3 事件流消费(drainStream 重写)
side-effect 标记用 `sideEffectSeen`(替代 cc 的 `emitted.any` 仅文本语义),遍历 `events`:
- `thread.started` → 拿 `thread_id`,调 `opts.onSessionId(thread_id)`(persist threadId)。**比 cc 更可靠**:threadId 在第一个事件就到,不用等 message。
- **任何**工具/副作用事件(`item.started` 或 `item.completed`,type ∈ {command_execution, file_change, mcp_tool_call, web_search})→ **立即置 `sideEffectSeen=true`**(C2:这些事件一旦出现就可能已执行命令/改文件,之后失败禁止 fresh retry,否则重复副作用)。同时若 `onToolUse` 则推脱敏进度(§6.6)。
- `reasoning` / `todo_list` 中间 item → 仅推进度(§6.6),不置 sideEffectSeen(无外部副作用),不进正文。
- `agent_message`(最终答复)→ **按 `item.id` 维护 `Map<id, text>`**:`item.updated`/`item.completed` 携带的 `text` 处理方式取决于 SDK 语义 —— 当前实测(0.142.3)agent_message **只发 `completed` 且 text 是完整快照**,无 `updated` 增量。设计上按"快照覆盖"(updated/completed 都直接覆盖该 id 的 text)。**但 Step 3c 必须先按 d.ts/实测确认 `item.updated` 是 snapshot(完整)还是 delta(增量)**:若是 snapshot→覆盖;若是 delta→追加。两种各写一个测试。turn 结束后把各 agent_message 的最终 text 按出现顺序 yield。置 `sideEffectSeen=true`(已产出对外内容)。
- `turn.failed` → throw(error.message);供 stale-resume 检测。
- `error` → throw。
- `turn.completed` → 记 usage(日志)。

### 6.4 systemPrompt / 安全前缀注入
- 保留 cc 的 `SECURITY_PROMPT_PREFIX`(IM 不可信输入防注入)+ SOUL/GROUP 指令。
- codex 注入方式:实测确认 —— 优先用 ThreadOptions 是否有 `baseInstructions`/`base_instructions`(查 d.ts);若无,则把安全前缀 + SOUL + group 指令**拼到 promptText 最前**,以明确分隔标记包裹(因 codex 无 system/user role 分离,需在 prompt 内用 cc 的 prompt-safety 标记法维持"用户内容不可越权")。**这是 §9 风险点 R1,开发首步先验证 codex 注入机制。**
- **注意**:prompt 内嵌的安全前缀是"软约束"(模型可能被绕过),不作为权限边界——权限边界由 §5 的 sandbox(默认 read-only)硬兜底(C5)。

### 6.5 stale-resume 恢复(保留)
- `isResumeError`:codex 的错误信息格式(threadId not found / no session)——**§9 风险点 R2,开发时实测一个被删 threadId 触发的真实报错文本再写正则**。
- 恢复逻辑同 cc,但门槛收紧(C2):resume 失败 **且 `sideEffectSeen===false`**(不只是"没产出文本",而是"没有任何命令/文件/工具副作用")→ onResumeFailed(清 id)+ 用 fallbackRetryPrompt 重跑一次(不 resume)。一旦 sideEffectSeen=true,即使失败也不自动 fresh retry(清 id 留给下一轮),避免重复执行命令/改文件。

### 6.6 进度消息脱敏(C7)
`onToolUse` 推给 IM 的进度**只含**:item 类型 + 一句动作摘要 + 短白名单字段,**禁止**带 stdout/stderr、文件 diff、完整命令参数。具体:
- `command_execution` → 只发 `执行命令: <命令首段截断≤MAX_TOOL_PARAM_CHARS>`,不发 aggregated_output。
- `file_change` → 只发 `修改文件: <path 列表,仅文件名/相对路径>`,不发 diff 内容。
- `mcp_tool_call` → 只发 `调用工具: <server>.<tool>`,不发 arguments/result。
- `web_search` → 只发 `搜索: <query 截断>`。
- `reasoning` → 默认**不推**(可能含敏感推理),或仅 `思考中…`。
复用 cc 现有 `MAX_TOOL_PARAM_CHARS` 截断 + 其测试。

## 7. 实现步骤(bite-sized,每步可测可验)

> 每步 TDD:先写/迁移测试 → 实现 → 测试过。优先用 cc 现成测试迁移。

### Step 0:仓库骨架
- 拷 cc 的 `package.json`/`tsconfig.json`/`vitest`/`eslint` 配置,改 name/bin/deps。
- `npm install`(含 `@openai/codex-sdk`)。
- **验收**:`npm run build` 空骨架通过;`npx codex-channel-octo --help` 不崩(待 cli 拷入)。

### Step 1:照搬纯 IM 层 + octo 协议层
- 拷 §4.1 全部文件 + `src/octo/{socket,types}.ts`;`api.ts` 改 agentPlatform。
- 批量替换日志前缀。
- 迁移这些文件对应的 `__tests__`。
- **验收**:这些模块的单测全过(socket 编解码、splitMessage、mention、session-store、inbound 解析等)。

### Step 2:config.ts
- 改 DEFAULT_CONFIG_PATH;重写 sdk schema(§5);去 cron/skills 字段。
- 迁移 + 改 config 测试(字段校验、默认值、目录解析)。
- **验收**:config 单测过;`loadConfig` 能读一个 codex 版示例 config。

### Step 3:agent-bridge.ts(核心)
- 3a 先做 §9 两个 spike(R1 注入机制 / R2 错误文本)。
- 3b TDD 写 `buildSdkEnv`(codex env 矩阵)单测 + 实现。
- 3c TDD 写 drainStream 事件映射:用**假 events 异步生成器**喂各类 ThreadEvent,断言 yield 文本 / onToolUse 调用 / onSessionId 调用 / throw。实现 queryAgent。
- 3d stale-resume 恢复单测(模拟 resume 错误)。
- **验收**:agent-bridge 单测全过(不调真 codex,全用 mock 事件流)。

### Step 4:index.ts 接线
- 拷 index.ts,去 cron/skill-linker/memoryDir 段,顶部本地化。
- 保持 queryAgent 接缝、teeChunks、onSessionId 持久化、fallbackRetryPrompt 组装。
- **验收**:`npm run build` 全绿;type-check 过。

### Step 5:CLI / configure / 示例 / README
- cli.ts/configure.ts 本地化;config 示例;README。
- **验收**:`codex-channel-octo configure`/`status` 可跑。

### Step 6:端到端冒烟(不接 octo,本地)
- 写一个 harness:直接调 queryAgent,真实调用本地 codex(deepminer provider),验证多轮 resume + onSessionId 落库。
- 前置:为该 bot 的 codexHome 准备 auth(`codex login` 或拷 `~/.codex/auth.json` 进 bot codex-home,或配 codexApiKey/codexBaseUrl)——否则独立 home 走 api.openai.com 报 401(R7 实测)。
- **验收**(两档):
  - 默认隔离档:连续两轮对话第二轮记得第一轮;DB `sdk_sessions` 有 threadId;`CODEX_HOME=<bot codexHome> codex exec resume <threadId>` 能接上(用 bot 自己的 home,不是个人 `~/.codex`)。
  - opt-in 互通档(仅当配 `codexHome:"~/.codex"`):个人终端 `codex exec resume <threadId>` 能接上 —— 作为可选冒烟项,验证卖点。

### Step 7:本地联调(localhost:3000,sid=50ul5b)
- 在本地 octo 建一个 codex bot,拿 bot token 写进 `~/.codex-channel-octo/<botId>/config.json`。
- `npm start`,在 IM 里跟 bot 对话,验证:注册 / WebSocket 连接 / 收消息 / codex 执行 / 回帖 / 多轮 / typing 进度。
- **验收**:IM 里能正常多轮对话;群里 @ 能触发;回帖正确。

## 8. 测试策略
- **单元**:照搬 cc 测试(IM 层) + 新写 agent-bridge mock 事件流测试。`vitest run` 全绿,`eslint --max-warnings 0`,`tsc --noEmit`。
- **集成冒烟**:Step 6 真实 codex 调用(标记为可选/手动,不进 CI 默认,因需 codex 登录)。
- **端到端**:Step 7 本地 octo 联调。

## 9. 风险与未决点(开发首步消解)

| ID | 风险 | 消解 |
|---|---|---|
| R1 | codex 无 system/user role 分离,安全前缀注入方式待定(baseInstructions? 还是 prompt 内嵌) | Step 3a spike:查 d.ts + 实测 `base-instructions`/ThreadOptions;确定后定 §6.4 |
| R2 | stale-resume 的错误文本格式未知,正则没法预写 | Step 3a spike:删一个 threadId 的 session 文件后 resumeThread,抓真实报错 |
| R3 | IM 不可信输入 → 任意用户驱动 bot 改文件(C5) | **默认 `read-only`**;workspace-write 需双开关;显式 danger-full-access 将文件/网络隔离交给容器或宿主,不再提供 bot 间文件隔离。AGENTS.md 刷新失败时终止无沙箱轮次;安全前缀仅软约束。见 §5 |
| R4 | codex 一次性投递 → 长任务期间用户只看到 typing,体验不如打字机 | toolProgress 推中间 item(命令/计划)作进度(脱敏 §6.6);可接受,记入 README |
| R5 | 共享 codex home 不止 threadId 串台,还有历史/auth/config/memory/终端会话互相可见(C6) | 见 R6:每 bot 独立 CODEX_HOME → 根上隔离;threadId 仍 UUID + sdk_sessions 按 sessionKey 映射,双层隔离 |
| R6 | 每 bot 独立 codex home + 互通改 opt-in(C6) | 默认 `codexHome=<baseDir>/<botId>/codex-home`,经 env `CODEX_HOME` 注入子进程(**已实测:session 确落到该目录**)。auth 需每 bot 各自登录/配 key。**互通卖点(IM↔终端同 session)= 显式 opt-in**:配 `codexHome:"~/.codex"` 才共享,README 明确警示"IM 内容会进入可被你个人终端 resume 的本地会话" |
| R7 | provider=deepminer 非官方;独立 home 缺 auth 会 fallback openai.com 报 401(**已实测**) | config 必须能设 codexBaseUrl/codexApiKey/env;独立 home **必须**各自 `codex login`(把 `~/.codex/auth.json` 拷入)或配 key/baseUrl,否则走 api.openai.com。Step 6/7 用真实 deepminer 配置验证 |

## 10. 完成定义(完全体)
- `npm run build` + `vitest run` + `eslint` + `tsc --noEmit` 全绿。
- Step 6 冒烟:多轮 resume 通过 + 终端 codex 可接续同一 session(默认隔离档用 `CODEX_HOME=<bot home>` 的终端;opt-in 互通档用个人终端)。
- Step 7 本地联调:IM 里多轮对话、群 @、回帖正常。
- 代码无 provenance 痕迹(无 review 轮次/工具名/AI 署名注释)。
- README + config 示例完整。
- runtime 侧集成(daemon adapter / fleet active)作为**后续独立 PR**,本计划不含。
