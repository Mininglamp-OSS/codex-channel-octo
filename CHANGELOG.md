# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Fixed

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
