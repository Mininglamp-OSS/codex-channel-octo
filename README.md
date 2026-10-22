<h1 align="center">codex-channel-octo</h1>

<p align="center">
  An independent Node.js gateway that bridges <a href="https://developers.openai.com/codex">OpenAI Codex</a> (via <a href="https://www.npmjs.com/package/@openai/codex-sdk"><code>@openai/codex-sdk</code></a>) to <a href="https://github.com/nicco-io/octo">Octo</a> IM.
</p>

<p align="center">
  <a href="https://github.com/Mininglamp-OSS/codex-channel-octo/actions"><img src="https://github.com/Mininglamp-OSS/codex-channel-octo/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node.js version">
  <img src="https://img.shields.io/badge/status-early%20test-orange" alt="Status: early test">
</p>

<p align="center">
  <b>English</b> · <a href="./README.zh-CN.md">简体中文</a>
</p>

---

> ⚠️ **Early test release (v0.1.0).** The core path (registration / connection / multi-turn chat / multi-bot) is verified and working, but the project is still maturing. **Known gaps:** no scheduled tasks (cron) and no skills yet — see the [CHANGELOG](./CHANGELOG.md). It mirrors its sibling [`cc-channel-octo`](https://github.com/Mininglamp-OSS/cc-channel-octo) (the Claude Code edition); only the agent core differs.

## What it is

A long-running process: register as an Octo bot → connect over WebSocket to receive messages → run a coding task with local Codex → post the reply back. Supports DM / group (@mention) / community topics, multi-turn conversations, multiple bots in one process, and config hot-reload.

Each adapter-framed user turn includes bounded current sender metadata: transport `from_uid`, channel ID/type, and `is_owner` computed against the last successful registration `owner_uid`. The same immutable metadata accompanies eligible proven pre-execution retries; uncertain executions are not replayed; it is deliberately not stored in shared `AGENTS.md`. Display names, quotes, and claimed IDs are not authentication, and forged sender markers in message text/history are escaped. This metadata identifies the sender but does not grant tool permissions or override security rules; enforce privileged actions in the host, not solely in a prompt. Direct terminal resumes outside the adapter do not establish an authenticated IM sender.

### Current-turn mention facts

The same adapter-generated metadata block includes `message_id`, `bot_uid`,
`mentioned_uids`, `mention_source`, `is_explicitly_mentioned`, `mentioned_ais`,
`mentioned_humans`, and `mentioned_all`. These facts come from the original
transport message, before a leading textual mention is stripped. Each new turn
refreshes the snapshot; eligible proven pre-execution retries reuse that
turn's snapshot without replaying uncertain executions. Direct terminal calls without adapter context have null IDs,
an empty UID list, source `none`, and false flags.

`is_explicitly_mentioned` means exact membership of the receiving runtime bot UID
in either validated transport list. Rendered `entities[].uid` and routing `uids`
are independent producer facts and are unioned and deduplicated; rendered spans
need not include every targeted account. `mention_source` records `entities`,
`uids`, `none`, or `invalid`. Broad AI/human/all flags accept only `true` or `1`,
and do not count as an explicit UID mention. Neither textual `@name`, quoted
messages, history, ownership, mention-free routing, nor authenticated internal
triggers establish that fact. These fields do not grant permissions.

UIDs are nonempty strings of at most 256 UTF-16 code units, with control and line
separator characters rejected; IDs remain opaque without trimming, case folding,
or space-prefix removal. Message IDs use the same validation with a 512-code-unit
limit. Each input array is limited to 128 entries. A malformed or oversized array
is discarded independently; valid sibling arrays and strict broadcast flags are
retained. Source `invalid` reports a rejected container/array; it no longer means
all independent facts are false. Invalid entries inside valid arrays are ignored.
Missing or invalid runtime bot identity produces `bot_uid:null` and false explicit
membership.

The prompt's UID snapshot is limited to 32 entries and 4096 serialized UTF-8 bytes
(including JSON escaping). `mentioned_uids_truncated:true` appears only when some
UIDs were omitted. Membership is computed before this snapshot cap, and a targeted
receiving bot is always retained. This bounds the new metadata amplification;
the existing security/sender framing remains outside the assembled body budget.

The router uses validated membership and strict AI flags, with a compatibility
probe for exact routing UID matches in oversized arrays or legacy scalar UIDs;
this probe does not relax prompt metadata validation; `all` and `humans` alone
do not activate regular bots. Invalid group mention data emits a fixed warning
with bounded SHA-256 channel/message correlation, never raw IDs or message text.
Text slicing validates entity offset/length separately and accepts ASCII `@` and
fullwidth `＠`. Broad AI admission does not strip a leading mention addressed to
another member. Entity positions prevent the legacy fallback from stripping a
teammate's mention when this bot is mentioned later. Invalid containers/arrays
preserve text rather than guessing a prefix to remove.

Sender metadata has these security properties:

- Exact validated registration equality is accepted. Bare registration UIDs may also be matched to prefixed transport UIDs for informational compatibility; the complete owner UID determines the candidate prefix.
- A supplied channel is required for inferred prefixed ownership. Every complete endpoint is checked before topic-parent extraction; literal `____` inside DM UIDs stays opaque. Empty identifiers fail closed. This is prefix compatibility, not proof of namespace equality: underscore-extended spaces can share a prefix. Authoritative full transport ownership or an explicit server space is required for host authorization.
- Attribution does not change DM session keys, SQLite SDK mappings, workspace paths or memory paths; their pre-feature routing parser is retained. No registration IDs are stripped, and IDs/names are not case-folded or Unicode-normalized.
- Metadata is bounded single-line JSON. Missing identity emits null fields and `is_owner:false`; identity precedes background and the request on initial, retry and recovery runs.
- Structural marker boundaries accept Unicode whitespace, format characters (`Cf`), nonspacing marks (`Mn`) and blank fillers. VT/FF/NEL normalize to newlines; general homoglyph detection is not claimed. Complete anchors and truncation notices count toward byte budgets; front truncation drops partial escaped lines. User data remains untrusted after escaping.
Group conversations fetch server `GROUP.md`; topics fetch only their own `THREAD.md`. Server notifications may be authored by a human manager or a bot. They are refetch hints, never authoritative updates/deletions: authenticated GET responses remain the source of truth. The per-bot LRU cache expires after 30 seconds, retries failures after 1 second, and coalesces repeated invalidations with a 1-second refetch floor. In-flight updates receive one bounded refetch. Server content is escaped JSON background, budgeted as a complete block so its untrusted label cannot be truncated away. Content/version changes are injected once per SDK session; unchanged documents do not accumulate. Fresh retries always receive full context, and verified deletion explicitly withdraws earlier document contents. Editing the document in Octo takes effect without a bot restart.

The existing operator-only `groupConfigDir/<channelId>.md` remains a separate, trusted local instruction override, reread each turn. It is not a server document cache and is not uploaded to Octo. This change adds server document consumption, not management/write tools.

**Headline feature — IM ↔ terminal Codex interop (opt-in):** each bot conversation maps to a Codex thread. With sharing enabled, you can resume a bot's group conversation from your own terminal via `codex exec resume <threadId>`, and vice versa.

Space attribution verifies topic parent and compound-DM prefixes using the canonical parentGroupNo helper, including group/owner identifiers with underscores and both endpoint orders. It consumes transport metadata, never a user-authored claimed UID. Prompt marker separators use one positive character class with a line-break guard, avoiding overlapping BOM alternatives and exponential backtracking on ordinary text.

## Install

```bash
npm install -g @mininglamp-oss/codex-channel-octo
```

Depends on `@openai/codex-sdk`, which bundles the Codex runtime (no separate Codex CLI install needed). Requires Node ≥ 22.

## Configuration

Server documents use a dedicated `[Server document — ...]` data marker, not the reserved `[Group context]` forgery marker or transcript labels. Empty documents generate no context on a fresh session; a withdrawal is sent only to a resumed SDK thread that previously received the document. Fresh retry snapshots omit absent documents. A second manager edit during a slow bounded refetch retains the last successfully verified snapshot instead of dropping it. Current-body role/section replicas are escaped and VT/FF/NEL normalized to newlines; this intentionally rewrites those control characters.

Two-layer, bot-first:

- **Global** `~/.codex-channel-octo/config.json` — shared defaults + the `bots` list, **no token**. See [`config.example.json`](./config.example.json).
- **Per-bot** `~/.codex-channel-octo/<id>/config.json` — that bot's `botToken` + overrides. See [`config.bot.example.json`](./config.bot.example.json). Each bot is a self-contained subtree: `<baseDir>/<id>/{config.json, SOUL.md, data/, workspace/, codex-home/}`.

Minimal example:

```jsonc
// ~/.codex-channel-octo/config.json
{ "apiUrl": "https://your-octo-instance.com", "bots": [{ "id": "default" }] }
// ~/.codex-channel-octo/default/config.json
{ "botToken": "bf_YOUR_BOT_TOKEN" }
```

### Codex authentication

Each bot has its own `CODEX_HOME` (`<id>/codex-home`) by default and must be authenticated, one of:

1. `CODEX_HOME=~/.codex-channel-octo/default/codex-home codex login`
2. Set `sdk.codexApiKey` (and `sdk.codexBaseUrl` if needed) in the per-bot config.

> An unauthenticated isolated home falls back to `api.openai.com` and returns 401.

### Group and topic mentions

The frontend's per-group no-@ reply toggle is supported without editing the
channel config. Enabling it permits ordinary group messages; disabling it
restores the mention requirement, unless a local override applies.

The channel reads `GET /v1/bot/groups/{parentGroupId}/mention_pref` before
answering an unmentioned group/topic message. The server's `effective` decision
controls automatic no-@ replies, including AI private sessions. Topics inherit
their parent's preference while retaining separate conversation histories.

Automatic no-@ replies require a confirmed human member. Other bots still need
an explicit mention unless listed in `allowedBotUids`. API failures or unknown
member classification keep the mention requirement. Preferences and member
classification are cached per bot and parent group for 30 seconds;
`mention_pref_updated` events invalidate that parent's cache.

Existing `mentionFreeGroups` entries remain explicit operator overrides matched
against the full channel ID. AI sessions covered by the server policy do not
need individual topic IDs added to this list.

### Reply selection and response limit

A Codex turn can contain several agent messages, for example narration before
a tool call and the answer after it. The channel picks **one** reply per turn.
That reply is what users receive and what is stored in conversation history,
so the two always match. `sdk.outputSelection` controls the choice:

| Value | Behavior |
|---|---|
| `final` (default) | Keeps all explicitly labeled final parts. Without final metadata, keeps only the last useful non-commentary item, regardless of earlier message lengths. Commentary-only output uses its last useful item. This is an ordering fallback, not inferred final intent. |
| `phase` (compatibility) | Uses the runtime's final-answer label when present. Otherwise all non-commentary messages are delivered, separated by a blank line; commentary-only output retains those messages. **Codex SDK/CLI 0.142.3 labels no messages, so in this mode intermediate narration is still delivered.** |
| `heuristic` (opt-in) | Keeps only the messages after the turn's last tool call / command / file change. It falls back to all messages when the turn did not complete, or when that would drop a long earlier message. This is an ordering heuristic, not a final-answer signal. |
| `legacy` (rollback) | Previous behavior: all messages of the final run, concatenated with no separator. |

**Default change:** an unset `sdk.outputSelection` now selects `final`. Explicit
`phase`, `heuristic` and `legacy` configurations retain their prior behavior.
Codex exec JSONL 0.142.3/0.162.1 omits phase metadata, so the default normally
logs `source=last_message`. Earlier messages are never restored based on length.
This avoids concatenating long progress narration with a short answer, but an
unlabeled earlier answer can be replaced by a short sign-off;
use explicit `phase` if retaining all unlabeled parts is required. Explicit
multipart finals are preserved. Snapshot updates replace the same item without
changing first-seen order. Whitespace/default-ignorable-only items cannot erase useful output; embedded
joiners in meaningful content are preserved.
Inherited/non-terminal fallbacks and explicit `partial_answer` selections have
partial diagnostic sources. Commentary-only fallbacks log `commentary_last`
(or `commentary_last_partial`), and do not apply beside blank non-commentary
items. These fallback labels are not proof that the task completed. See [the source investigation](docs/final-output-policy.md).

When a stream interruption is recovered and the recovery run produces no
message, the interrupted run's messages are used instead. These may be
narration.

`maxResponseChars` (default `524288`) caps the reply. An over-limit reply is cut
so the delivered text, including the trailing `[response truncated]` notice,
never exceeds the limit. The stored history is capped the same way. Limits from
1 to 44 truncate without the notice, and a warning is logged at startup.
**Non-integer and non-positive values are rejected; positive integers remain
supported.** An invalid value stops startup. During hot reload it is logged and
ignored, and the running bots keep running.

Both settings apply when a bot starts. After editing them, restart the process
or re-add the bot under a new id. Hot reload only adds or removes bots by id.

### Card configuration (startup only)

The global config, inline `bots[]` entry and per-bot config file accept a closed
`cards` object. These are local preferences; configuration does not prove server
policy, routing authority or event-consumer topology authorization.

| Field | Exact values | Default | Meaning |
|---|---|---|---|
| `cards.disable` | `false`, `true` (boolean) | `false` | Local narrowing kill switch. `true` disables locally; `false` grants no capability. |
| `cards.eventTransport` | `"off"`, `"short"`, `"long"` | `"off"` | Transport preference only. Selecting a mode cannot enable intake without independent topology and authorization proof. |
| `cards.reasoningSummary` | `"off"`, `"on"`, `"stream"` | `"off"` | Summary preference only. It does not authorize reasoning content, source/privacy acceptance or production use. |

Precedence is global → inline `bots[]` fields → `<id>/config.json`, with later
explicit fields winning **individually**. Omitted fields inherit; defaults fill
remaining omissions. For example, global `{"disable":true,"eventTransport":"off"}`
and per-bot `{"reasoningSummary":"off"}` resolve to
`{"disable":true,"eventTransport":"off","reasoningSummary":"off"}` for that bot
only. An empty `cards: {}` inherits everything. Each bot receives a separate,
frozen snapshot. No local preference can grant server capabilities.

Wrong booleans/enums, null, arrays and unknown fields (including `_comment`
inside `cards`) fail startup. Values are never coerced. An invalid lower layer
is rejected even if a higher layer would override it. Diagnostics omit supplied
keys, values, credentials, Bot ids and paths. Put example comments beside the
`cards` object, not inside it.

Settings are resolved when a bot starts. Editing source configuration does not
change a running bot's snapshot. The existing watcher reconciles IDs only: an
edit retaining the same ID does **not** restart that bot. An actual process/Bot
restart, or explicit removal followed by re-addition, gets a fresh snapshot.
Invalid edits leave the current running set intact. This is configuration
boundary behavior, not a watcher, hot-reload or platform stability guarantee.

Deprecated top-level `cardProgress`, `reasoningCardTemplateMode`, `cardDisplay`,
`cardInteraction`, `OCTO_CARD_MESSAGE_ENABLED` and `OCTO_CARD_MERGE_FINAL` are
ignored for canonical cards. The two `OCTO_` environment names are ignored too;
each ignored key emits at most one fixed warning per process, without its value.
They are not compatibility aliases. Generic `sdk.env` forwarding remains
unchanged and cannot alter canonical card settings.

This configuration boundary adds no event consumer, summary delivery or runtime
card wiring. Live/deployment acceptance remains separate; configuration alone
does not satisfy R03/S05 or authorize production enablement.

## Run

```bash
codex-channel-octo start        # start in background (supervisor)
codex-channel-octo status       # show status
codex-channel-octo stop         # graceful stop
npm start                       # foreground (debug)
```

## Security model

IM input is **untrusted**; the permission boundary is the **sandbox**, not the prompt:

- **`sandboxMode` defaults to `read-only`** — the first release targets safe Q&A / code review. To let a bot edit files you must set **both** `allowWorkspaceWrite: true` and `sandboxMode: "workspace-write"` (a double switch to guard against misconfig).
- **`sdk.additionalDirectories`** — extra **writable** roots outside the per-session cwd (e.g. a shared work bus). Only attached under `workspace-write` (inert, so omitted, under `read-only`, and dropped if a turn is force-downgraded on AGENTS.md write failure). Entries must be **absolute paths** (no `~`/relative, no `..`) and are rejected at boot if they contain, equal, or sit inside a trusted/sensitive directory — the session cwd, the config/SOUL tree, `groupConfigDir`, the memory dir, or `codexHome` — so a writable root can never overlap the files that establish the agent's trust boundary.
- Explicitly setting `sdk.sandboxMode: "danger-full-access"` disables Codex sandboxing and delegates isolation to the container or host. Commands can access files and mounts permitted to the running user; workspace and sensitive-subdirectory write protections no longer apply.
- `networkAccessEnabled` / `webSearchEnabled` are off by default. In `danger-full-access`, Codex does not restrict the network, including when `networkAccessEnabled` is false; `/config` reports this effective behavior.
- A non-overridable security prefix (anti-injection) is written into each session's sandbox `AGENTS.md` and restated atop the prompt (defense in depth, but only a soft constraint).
- Each bot has its own `CODEX_HOME`, so IM content does not land in your personal `~/.codex` by default.

### Private MEMORY.md (opt-in)

Place an operator-maintained `MEMORY.md` beside `<baseDir>/<botId>/SOUL.md` and set `"privateMemory": { "enabled": true, "maxBytes": 16384 }` in the global or per-bot config (per-bot fields override inline/global fields). Disabled by default; `maxBytes` accepts integers from 1 to 65536. Configuration changes require a restart; eligible turns re-read the file, so note edits/deletion take effect on the next turn.

Only an explicit DM with a transport sender matching the **last successful registration** `owner_uid` is eligible. Groups, topics, other senders and unknown identities cause no memory file read. The bounded snapshot is framed as untrusted JSON background in every eligible SDK run, including supported pre-execution retries; uncertain stream/stale-thread failures retain the fail-closed policy and are not automatically replayed. It is never written to shared `AGENTS.md`. Missing/unreadable files produce a safe absence/unavailability notice; file symlinks and non-regular files are rejected. This first milestone does not load `memory/` daily notes, search, write notes, or add compaction hooks.

When enabled, ordinary/private-memory conversations use separate namespaced histories, SDK threads and working directories. Enabling/disabling starts a different history scope for every conversation, including groups and non-owner DMs, without deleting older records; plan the rollout as a conversation-continuity reset. After a successful re-registration observes a different owner, former owners select the ordinary scope rather than their prior private-memory thread. `/reset` clears the current scope but never deletes `MEMORY.md`. Snapshots are repeated deliberately in this initial implementation; they are byte-bounded, not deduplicated across a resumed thread.

**Ownership transfers:** healthy heartbeats do not re-register or refresh ownership. This feature does not provide live revocation: the former owner remains eligible while the cached registration still names them. Before transferring a bot, stop/drain it; restart and complete registration under the new owner before resuming traffic or editing private notes. Socket reconnection alone does not guarantee re-registration. A successful registration refresh (including token refresh) also updates the owner snapshot. The tests cover these producer/consumer boundaries, not instantaneous server-side transfer detection.

Files writable by a group or other users are refused (`mode & 0022`); use operator-owned mode `0600` for confidentiality as well. Non-ENOENT failures emit only a closed diagnostic code and safe bot label, never paths, note text or raw exception messages. A truncated prefix remains available even when it contains only whitespace or an incomplete UTF-8 character. Final-component symlinks are refused; parent-directory symlinks and hardlinks are not containment guarantees. Protect the directory tree externally.

**Privacy boundary:** this filters adapter injection, not arbitrary filesystem access. A read-only sandbox may still permit reads outside cwd; `danger-full-access` removes filesystem isolation. A tool running as the gateway user may also overwrite the note, even if it is mode `0600`; JSON framing does not make those facts trustworthy. Do not expose private files to untrusted users without an external filesystem/container boundary. Also do not share an operator's Codex home across unrelated users: the SDK's transcript storage is outside this feature's scope.

### Safe failure handling and recovery

After the interrupted handler settles and gateway-owned execution is confirmed stopped, new user requests can run with retained failure context, without replaying the old request. Requests queue during bounded cleanup; missing proof and historical/crash quarantine remain paused across reset/restart. See [session continuity](docs/session-continuity.md). Cancellation before SDK execution stays clean. New retries default off and cover only positively proven
pre-execution temporary failures. After verifying effects, an owner whose wire
UID **exactly matches registered owner_uid** can send:

```text
/reconcile TURN_ID --external-results-verified
/reconcile TURN_ID --session SESSION_KEY --external-results-verified
```

Explicit targets require the owner's own DM. Exact target/turn and retained
handler checks apply; controls never replay, resend or erase history. Successes
and refusals are audited using hashed identities and closed outcomes.

**Rewritten owner UIDs require offline maintenance.** The current API returns
owner_channel_id equal to owner_uid; it supplies no scoped identity binding.
Incoming UID suffixes cannot authorize controls. Startup and pause notices state
that a differently prefixed wire UID needs an operator to verify effects, stop
the gateway and use the [offline helper](docs/issue-26-safe-recovery.md). This may
interrupt every bot in the supervisor. A UID registered with its prefix already
works by exact equality. Prompt is_owner metadata is advisory, not this ACL.

Quarantined traffic has its own bounded aggregate budget plus sender/session
limits; it cannot exhaust healthy model admission or admit unlimited senders.
Active rows retain the normal budget. Paused group chatter remains in the bounded
context cache; control commands do not. The 300-second dispatch timeout can be
adjusted for long tasks without waiving execution reconciliation.

### Unicode JSONL transport compatibility

On macOS/Linux, an executable proxy escapes raw U+2028/U+2029 in CLI stdout before the SDK's `readline` reader. These are legal JSON string characters, but Node v24.10.0 treats them as line endings and can split valid events, yielding `Failed to parse item` and killing the SDK child. Escaping preserves the decoded event contents, including command output; UTF-8 chunks, stdin, stderr, backpressure and signals are forwarded. The proxy resolves the CLI dependency belonging to the installed SDK. Windows retains direct SDK launch; this Unix workaround is not a validated Windows fix.

JSONL parse failures are logged as redacted categories, not rejected event payloads or subprocess stderr. New user-authored turns may reuse the known thread; interrupted turns are never automatically resumed or replayed. Invalid events are never silently discarded. Tests reproduce the Node reader behavior and use the real SDK with synthetic executable fixtures, without model/network requests or private notes.

If the proxy is missing, non-regular or not executable, the adapter warns once with `npm run build` instructions and falls back to direct SDK launch; this fallback does not provide the Unicode workaround. `dev` builds/copies the proxy before starting the TypeScript watcher (re-run build after editing the `.mjs`), and `prepack` builds before packaging. CI validates executable package contents and runs tests on Node 22 and 24.10.0. Bootstrap resolution failures emit a fixed actionable diagnostic, without paths or raw stderr. Logs retain built-in error classes and allowlisted OS/Node error codes; mutable error names/codes are not trusted as safe text.

The launcher chain adds two Node processes. Graceful signals are forwarded while the child remains alive and pending proxy stdout is flushed before signal exit; SIGKILL cannot be handled and external supervision is still needed for orphan cleanup. The official CLI shim preserves its environment setup, but the SDK's own bundled PATH injection is bypassed: native CLI search self-locates ripgrep, while direct shell `rg` may require a system installation.

The SDK override selects a private executable shell launcher which uses `exec` with the running absolute Node interpreter, not PATH lookup for `node`. Launchers are cached per proxy path and removed on normal process exit. Explicit cancellation stops forwarding output, drains child pipes independently of the downstream reader, and escalates an unresponsive child to SIGKILL after 1.5 seconds; shutdown has a further 0.5-second bound. Natural child signal exit still flushes queued output, whereas cancellation may discard output because the consumer has stopped. The transform assumes valid UTF-8 JSONL, not arbitrary binary stdout. Relay/router error logs use the same payload-denying summarizer; SDK parse errors can never classify as stale-thread signals, including during recovery.

### Dedicated Docker configuration

Use [`config.bot.docker.example.json`](./config.bot.docker.example.json) for a dedicated Docker container. That template defaults to `danger-full-access`. For an existing bot, set this field inside `sdk`:

```json
{ "sdk": { "sandboxMode": "danger-full-access" } }
```

This mode does not require `allowWorkspaceWrite` or a network toggle. Restart the Channel after editing and confirm the mode with `/config`. Docker's default seccomp policy is expected to suffice without `privileged`, `SYS_ADMIN`, or a custom seccomp profile; this has not yet been validated in a live container. Host and container access restrictions still apply.

The program still defaults to `read-only`; detecting Docker never changes permissions automatically. Use a dedicated container for each trust boundary, without host credential or Docker socket mounts. Different bots in the same container no longer have Codex filesystem isolation. If the current turn's `AGENTS.md` cannot be refreshed, that turn stops with an error.

## IM ↔ terminal interop (opt-in)

Isolated by default. To enable interop, point a per-bot `sdk.codexHome` at your personal `~/.codex`:

```jsonc
{ "botToken": "bf_...", "sdk": { "codexHome": "/Users/you/.codex" } }
```

After that, a bot's group conversation can be resumed in your terminal with `codex exec resume <threadId>`. **Note: IM content then enters your personal Codex session history.**

## Differences from the Claude edition

| | cc-channel-octo | codex-channel-octo |
|---|---|---|
| Core | `@anthropic-ai/claude-agent-sdk` (in-process) | `@openai/codex-sdk` (spawns local codex) |
| Session | SDK session id | Codex thread id (stored in `~/.codex/sessions`, terminal-resumable) |
| Streaming | per-chunk | final message delivered whole + intermediate steps as progress |
| Permissions | permissionMode / allowedTools | sandboxMode / approvalPolicy |
| System prompt | SDK preset + append | session sandbox `AGENTS.md` |

## Development

```bash
npm ci              # reproduce the committed dependency lock
npm run runtime:update  # refresh SDK + paired CLI to latest stable
npm run build       # compile TypeScript and copy/chmod the JSONL proxy
npm test            # vitest
npm run lint        # eslint --max-warnings 0
npm run type-check  # tsc --noEmit
```

### Private operator diagnostics (opt-in)

Set `sdk.privateDiagnostics: true` to retain local failure metadata correlated with task IDs. SDK message text is fingerprinted, never stored; public replies remain unchanged. Records use owner-only rotated files (three files of at most 1 MiB each). See [privacy, rotation, and interpretation](docs/private-diagnostics.md).

### Codex runtime versions

Fresh installs of the published adapter resolve `@openai/codex-sdk` from npm's stable `latest` tag. The SDK selects its own paired CLI; an unrelated globally installed `codex` is not used. The committed lockfile pins the tested pair for reproducible development builds (`npm ci`). An existing lockfile can keep an old runtime even after `npm install`.

In a source/packaging checkout, explicitly refresh the runtime before testing and packaging:

```bash
npm ci
npm run runtime:update
npm run build
npm test
npm pack
```

`runtime:update` runs `npm update @openai/codex-sdk` and then `runtime:check`; it updates the checkout's lockfile while preserving the `latest` dependency tag. `runtime:check` resolves the CLI from the installed SDK, launches its actual `--version`, and reports SDK/CLI/native versions. It rejects missing or mismatched runtimes without invoking inference or requiring authentication. Do not copy old node_modules into a fresh install and assume the runtime was upgraded. This command changes dependencies; use a staging checkout and validate before deploying. It does not restart the gateway.

CI covers both the committed lock and a refreshed latest stable runtime on Node 22/24, including strict types, native CLI startup, the real SDK/proxy/process regression suite and packaging. Future latest releases require a passing compatibility lane; an update failure must be reported, not silently presented as a successful upgrade. To deliberately reproduce an older release, use that release's committed lockfile. Never independently override the CLI version selected by the SDK.

## License

Apache-2.0

Detailed private diagnostics require both `sdk.privateDiagnostics: true` and `sdk.privateDiagnosticsDetails: true` (both default off). Only bounded allowlisted metadata is retained, never arbitrary message text. The hardened writer requires POSIX no-follow/directory/nonblocking flags and a pre-existing local data directory; symlinked ancestors, hard links and files accessible to group/others are rejected. Missing required flags fail closed before creating files. Native Windows and network/FUSE filesystem compatibility are not established. See [private diagnostics](docs/private-diagnostics.md).

Mention admission compatibility: an oversized routing UID array is scanned for an exact receiving-bot UID, and a legacy scalar UID is accepted only on exact equality. This does not relax the bounded prompt snapshot: rejected metadata remains `invalid` and does not claim an explicit mention. No substring matching is used. Rendered teammate spans at offset zero are preserved; a leading bot prefix can be removed when only later entities exist.

## Source-checkout test tools

See [Isolated test profiles and capture](docs/isolated-test-profiles.md) for profile lifecycle, protected capture/readback setup, runtime requirements and reproducible checks. These helpers are not included in the npm installation.
