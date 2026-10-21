# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Fresh published-package installs select the latest stable Codex SDK and its paired CLI; keep a reproducible lockfile, add runtime update/version verification commands and a Node 22/24 latest compatibility CI lane.

- Separate `sdk.privateDiagnosticsDetails` opt-in for bounded allowlisted SDK failure metadata; requires `privateDiagnostics` and never captures arbitrary text.
- Opt-in `sdk.privateDiagnostics` saves bounded owner-only failure metadata and SDK message fingerprints. Raw SDK/error/prompt/tool payloads stay excluded; rotation is limited to three 1 MiB files and diagnostic I/O failure cannot alter task behavior.

- Strict global/inline/per-bot `cards` field merge with independent frozen
  startup snapshots. Defaults: `disable=false`, `eventTransport="off"`,
  `reasoningSummary="off"`. Local preferences grant no server or routing
  authority. Invalid card settings fail startup with fixed diagnostics;
  deprecated card flags are ignored with bounded, value-free warnings.
  Same-ID edits do not restart Bots; restart or explicit remove/re-add is
  required. Runtime card wiring and production enablement remain separate.

### Changed

- Harden private diagnostics with no-follow/inode/hard-link/permission checks; require a pre-existing data directory and POSIX safety flags. Unsupported flags fail closed before filesystem mutation; native Windows and network/FUSE filesystem compatibility are unverified.
- Diagnostic capture and provenance lookup avoid SDK accessors/proxy prototype reflection; hostile classifier inputs fail closed without executing traps.

### Fixed

- Require exact registered owner identity for online recovery. The current Bot
  API does not provide scoped-alias bindings; rewritten owner UIDs now receive
  an explicit offline-maintenance path. Add hashed recovery audits, a separate
  aggregate paused-traffic budget, pause-time group-context caching and CI type
  checks for recovery contracts, with real-handler quarantine regressions.

- Allow a new user request or explicit continuation in the same conversation after interrupted execution has stopped. Keep failed-task context and late-callback fencing without automatically replaying the old request; queue new requests during bounded cleanup and retain maintenance protection when teardown cannot be confirmed.
- Confirm interrupted POSIX teardown using gateway-owned child handles and independent process-group checks; workload-writable proofs never authorize reopening. Preserve interruption context across slash commands until a successful model response is committed.
- Bind privileged recovery to registration-provided owner identities and allow
  owner-DM recovery of explicit third-party sessions without gateway downtime.
  Paused traffic no longer consumes the global model budget; active tasks have
  distinct refusal messages. Retain unresolved output evidence through expiry,
  document local-only correlation IDs, and preserve safe API endpoint/status
  diagnostics across POST/GET/upload failures without retaining server bodies.

- Registered owners can reconcile one paused conversation in chat without taking the gateway offline. Pause notices include its exact task ID; active local handlers, wrong task IDs and non-owners cannot release it. Offline release is no longer shadowed by an in-memory pause flag.
- Timeout and graceful shutdown do not quarantine positively unstarted model turns. Unknown/observed effects remain protected and are never automatically replayed.
- Completed execution tombstones expire with retention; unresolved evidence survives. Removed unused stale-replay options and prompt assembly.

### Added

- Per-turn transport sender metadata matched to the registration UID or its
  single prefix in the transport space (including UUID/operator-named spaces);
  identity is kept out of shared AGENTS.md. Unicode whitespace/invisibles are
  handled consistently around section and role markers. Every request has an
  anchor; absent sender metadata explicitly fails closed on resumed threads.
- Fetch server GROUP.md/THREAD.md as separately labelled, bounded conversation
  data; manager edits trigger authenticated refetch without trusting event payloads.

- Explicit `sdk.sandboxMode: "danger-full-access"` support for externally
  isolated deployments, with a dedicated Docker configuration template.
  General defaults remain read-only; `/config` reports unrestricted Codex
  network access in this mode, and AGENTS.md refresh failures stop the turn.
- **`sdk.additionalDirectories`** — optional list of extra **writable** sandbox
  roots outside the per-session cwd (e.g. a shared work bus), forwarded to the
  Codex SDK. Only attached under `workspace-write`; omitted under `read-only`
  and dropped when a turn is force-downgraded on AGENTS.md write failure.
  Entries must be absolute paths (no `~`/relative/`..`) and are rejected at boot
  if they contain, equal, or sit inside a trusted/sensitive directory — the
  session cwd, the config/SOUL tree, `groupConfigDir`, the memory dir, or
  `codexHome` — so a writable root can never overlap the agent's trust anchors.
- **`sdk.outputSelection`** (`final` default; `phase`, `heuristic` and `legacy`
  compatibility modes) selects one reply shared by delivery and stored history.
  Explicit final parts are preserved. Without labels, the last useful message
  is selected regardless of earlier message lengths, preventing long progress
  narration from being restored before a short answer. Unlabeled multipart
  answers may lose earlier parts; explicit compatibility modes remain available.
  Commentary and partial fallbacks have distinct diagnostics. Applied at bot
  start (restart or re-add the bot after editing).

### Changed

- Multiple agent messages in one reply are now separated by a blank line
  (`legacy` keeps the old concatenation).
- `maxResponseChars` now bounds the whole delivered reply, including the
  `[response truncated]` notice. Limits from 1 to 44 truncate without the
  notice. Stored history is capped the same way instead of keeping the
  untruncated text. Non-integer and non-positive values are rejected at
  startup (and ignored with a log on hot reload); positive integers remain
  supported.

### Fixed

- Add safe failure categories, bounded opt-in pre-execution recovery and cancellable
  dispatch. Quarantine uncertain timed-out/crashed execution, fence late callbacks,
  persist delivery outcomes and commit confirmed history once per turn. Stop
  automatic replay/continuation when execution safety cannot be established.


- Keep Octo recovery alive after failed token refreshes and cooldown-suppressed
  requests, independently of successful REST heartbeats. Coalesce retry timers,
  ignore retired-socket callbacks and cancel/abort recovery on shutdown.
- Bound WebSocket/CONNACK handshakes and retain backoff reconnect after rapid
  disconnect hints, so transient failures recover without restarting the gateway.
- Preserve pre-feature DM session keys, persisted SDK mappings, workspace and
  memory paths; sender attribution no longer changes DM routing parsers.
- Escape Unicode format/nonspacing marks and blank fillers at structural marker
  boundaries, including supplementary-plane characters, without ambiguous
  separator alternatives. Match complete unescaped request anchors only.
- Validate all endpoints before topic extraction and reject empty endpoint IDs.

- Treat compound-DM endpoint UIDs as opaque, applying topic parent extraction
  only to topic channels so literal `____` cannot hide a cross-space endpoint.

- Keep section suffixes within one line and outside nested opening brackets;
  restore punctuation-delimited role labels and verify compound DM/topic channel
  prefixes against the sender-derived candidate rather than guessing UID boundaries.
- Remove overlapping separator alternatives that let BOM-prefixed ordinary
  text cause exponential prompt-escaping backtracking; derive topic ownership
  from the parent channel and sender prefix boundaries from the complete owner UID.
- Preserve JSONL events containing Unicode LS/PS on Unix, safely fall back when
  the proxy is unavailable, and redact event payloads while retaining error classes/codes.

- Drop the first partial line of front-truncated escaped history, preventing a
  sliced-off escape from introducing a second privileged current-message anchor.
- Persist server-document injection signatures alongside SDK session mappings,
  retaining deletion withdrawals across restarts and cache eviction. Clear state
  on thread replacement/reset and conservatively withdraw for legacy mappings
  with unknown injection history; no document bodies are stored in this ledger.
- Retain a verified server snapshot when a second invalidated fetch fails,
  retrying after the short failure TTL. Record only context in the actual SDK
  run prompt, not context planned for another recovery attempt.
- Keep reading Codex replies after the known model-metadata fallback notice,
  logging it as a warning while continuing to surface other error items.
- Recover stale threads reported as `no rollout found` by clearing the invalid
  mapping and retrying once on a fresh thread when no side effect has occurred.

## [0.1.0] - 2026-06-29

First, early test release. Bridges OpenAI Codex (via `@openai/codex-sdk`) to
Octo IM as an independent Node.js gateway. The structure mirrors its sibling
`cc-channel-octo` (Claude Code); only the agent core differs.

### Added

- **Codex agent bridge** — wraps `@openai/codex-sdk` (`startThread` /
  `resumeThread` / `runStreamed`). Each Octo session maps to a Codex thread
  whose id is persisted, so multi-turn conversations resume across messages.
  Because Codex threads live in `~/.codex/sessions`, a bot's IM conversation can
  also be resumed from your own terminal (`codex exec resume <threadId>`) when
  the bot's `codexHome` is shared.
- **Octo channel layer** — registration, WuKongIM encrypted WebSocket
  (Curve25519 + AES-CBC), REST send/heartbeat/history/media, DM + group +
  community-topic, @mention awareness — carried over unchanged from the proven
  `cc-channel-octo` protocol layer.
- **Multi-bot, single process** — run many independent bots from one gateway,
  each with its own token, sandbox, SQLite store, and per-bot `CODEX_HOME`.
  Config is hot-reloaded on change.
- **Per-bot isolation** — each bot gets its own `CODEX_HOME`
  (`<baseDir>/<id>/codex-home`), so IM content does not land in the operator's
  personal `~/.codex`. Sharing the personal home is opt-in.
- **Security defaults for untrusted IM input** — `sandboxMode` defaults to
  `read-only`; `workspace-write` requires both `allowWorkspaceWrite: true` and
  `sandboxMode: "workspace-write"`; `danger-full-access` is rejected. A
  non-overridable security prefix is injected via the session `AGENTS.md` and
  restated atop each prompt. Tool-progress notices are redacted (program name /
  file basenames only — never stdout, diffs, or full arguments).
- **CLI supervisor** — `start` / `stop` / `status` / `restart` / `configure`.
- **In-chat commands** — `/reset`, `/config`, `/help`.

### Known limitations (planned for later versions)

- **No scheduled tasks (cron)** — the agent cannot schedule reminders/tasks yet.
- **No skills** — per-bot skill libraries are not wired in yet.
