# Experimental app-server runtime (#72)

`sdk.runtime: "app-server"` runs each managed attempt on a gateway-owned `codex app-server --listen stdio://` child. The child is the packaged native binary of exactly `@openai/codex@0.163.0`. The default is `exec`, and on the default the SDK path behaves exactly as before. Explicit card tools are declared as host-dispatched `dynamicTools`: `item/tool/call` requests arrive on the gateway's own pipe and are handled in-process. No listener, bootstrap ticket or MCP entry is involved. Card injection still needs every existing gate, and `PRODUCTION_EXPLICIT_OPS` is still empty, so enabling the runtime adds no card behaviour on its own.

## Launch contract

- **argv:** global `-c`/`--disable` flags, then `app-server --listen stdio://`. `--remote-control` is never passed.
  - The `-c` flags force `cli_auth_credentials_store="ephemeral"` and `forced_login_method="api"`, and carry the SDK-equivalent thread options.
  - The `--disable` flags cover the PR #71 card list (`apps`, `plugins`, `remote_plugin`, `hooks`, `skill_mcp_dependency_install`, `code_mode_host`) plus `multi_agent` and `daemon_auto_start`.
- **env:**
  - Built from an allowlist (paths, locale, proxies, CA roots) plus `sdk.env`.
  - Auth markers and gateway control fields are always stripped.
  - `CODEX_HOME` is set explicitly, and `CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED` is set to exactly `1`.
- **Pre-spawn fence.** Every check is fail-closed, happens before spawn, and is never retried:
  - The same binary runs with the same flags and env as `features list`, and every required feature must report `false`. An unknown key exits non-zero, so a Codex bump that renames a feature refuses to start.
  - `/etc/codex` and a managed Codex plist must be absent. A managed `cli_auth_credentials_store` would override the ephemeral store.
  - `CODEX_HOME` must be absolute.
  - An API key must be configured.
- **Login (C1).** On every child: `initialize` → `account/login/start {apiKey}` over the pipe → `account/read` must report API-key auth. The key never enters the child env, argv or logs.

## Attempt lifecycle and classification

- **Ready phase.** Spawn in its own process group, then the ready sequence, then `thread/start` (tools declared) or `thread/resume` by the stored id (never tools). The ready phase is bounded at 10 s.
- **Turn binding (TB-0..TB-3, addendum A1).** Exactly one `turn/start` is sent. The first matching `turn/started` or the response binds the turn. These close the attempt:
  - an error response;
  - a response id that does not match the bound id;
  - a different `turn/started` inside the window;
  - turn activity on our thread before our `turn/start` was enqueued, including activity that arrives in the same read as the thread reply (its thread ids are kept until the thread id is known, at most 32, then fail closed);
  - a terminal that arrives before the response, unless the response then settles to the bound id within 5 s. Until then the terminal is not emitted.
- **Event projection.** v2 notifications are projected onto the SDK `ThreadEvent` shape, so selection, progress, risk and failure handling are the exec path's. `error.willRetry=true` is a notice only. Agent messages are projected only on completion. A completed `dynamicToolCall` is an effect, never text.
- **Classification (unchanged from exec).** `risk=unknown` is set immediately before spawn. Only a structured OS spawn error stays retry-eligible: one seen before the OS reported the child started and before any frame was written. Every post-spawn failure is `blocked_uncertain` and carries a bounded class name. The classes are `auth_login_rejected`, `auth_mode_mismatch`, `ready_timeout`, `child_exit_before_ready`, `thread_rejected`, `turn_rejected`, `turn_binding_mismatch`, `child_exit` and `transport_closed`.
- **Cancel.** `turn/interrupt` (5 s bound), then stdin EOF, then a verified SIGTERM/SIGKILL of the process group (10 s bound).

## Card dispatch

The dispatcher follows XIN-2384 rev2 §5–§6 plus addendum A1–A5.

- **Routing:**
  - Calls are routed by thread and trusted turn.
  - Early calls are held uncharged (32 per binding) and keep their original timer.
  - Foreign, unbound, post-turn, unknown-tool, over-cap and late-admission calls get uncharged refusals.
  - Uncharged replies are capped at 256 per child. Reaching the cap closes the client.
- **Logical key:** `request_id = a1:<sha256(RFC 8785 [threadId, turnId, callId])>`, using the existing ledger primary key.
  - An identical replay joins at 0 invocations, with at most 4 joins per row.
  - A changed body is `request_id_reused`.
  - The argument grammar and the body digest are the MCP frames'.
- **Timing:** reply timer 16 s, reply written within 2 s of enqueue (the writer bound), call admission 78 s remaining.
- **R-4 outcomes on timer or binding close:**
  - charged → `cancelled`;
  - reserved but unsent → `cancelled`/`abandoned`, and the slot is not refunded;
  - possibly sent → `ambiguous`, with no resend.
- **SC-1 (card schema v3):**
  - Rows the dispatcher settles carry `settled_by='app_server'`.
  - Such a row, once `ambiguous`, never accepts a later `acked`/`failed`.
  - A late outcome goes once to `late_outcome`/`late_message_id`/`late_at`. A late ack may bind the card through the existing T-bind, with the current reset epoch and a fresh policy decision.
  - The request state, the safe result and the budgets never change.
- **Toolset (T0/T2a/T5 R1):**
  - New threads declare `display` and `interactive`, and the toolset digest is stored next to the thread id.
  - Exec-era threads, and threads started while cards were off, keep their history without explicit tools until a reset or a new session. This produces a log line, a metric and an availability line.
  - D3: on every turn of such a thread while cards are offered, the gateway adds a short notice as a separate `turn/start` input item ahead of the unchanged prompt. It is never written to gateway history. Codex keeps turn input in its own thread, so earlier notices remain visible there as history. New threads, current threads and card-off turns get no notice.
  - Per-call Bot policy stays authoritative.

## Gate matrix

| Gate | Status | Evidence |
|---|---|---|
| G-A0 pinned binary | **real** | `app-server-spawn.test.ts` resolves the installed 0.163.0 native binary and refuses other versions and platforms |
| T-ARGV / T-ENV / fence | unit + **real** | The real-binary fence passes with the list, and refuses an unknown key and the default build |
| G-A1 projection, new/resume, terminal | **real binary, model mocked** | `app-server-real-binary.test.ts`; scripted edge cases in `app-server-runner.test.ts` (mocked app-server) |
| G-A2 dynamic-tool round trip, TB-0..TB-5, holds, joins, foreign, R-4 | **real binary** for the round trip; unit for the rest | `app-server-cards-real-binary.test.ts`, `cards-app-server-dispatcher.test.ts`, `app-server-runner.test.ts` |
| G-A3 resume keeps tools; old thread has none | **real binary, model mocked** | `app-server-cards-real-binary.test.ts`. Finding: `developerInstructions` on a cold `thread/resume` is **not delivered** by 0.163.0. The R1 notice therefore reaches the model as D3 turn input (asserted in the request body); the unchanged R1 `developerInstructions` line stays alongside it |
| G-A3b (R2 seeding) | not in scope | R2 was not selected |
| G-A4 no listener, no plugin fetch, remote control off | **real** | lsof and process-group checks during a turn |
| G-A5 in-memory login, no `auth.json` | **real** | Bearer from the in-memory login; no auth file in `CODEX_HOME`. The managed-store negative control is covered by the fence refusing host-administrative layers (unit); a real managed preference was not installed |
| G-A6 latency (E-R5a/b), R-9a cap values | **not run** | Needs a real provider; the cap values stay placeholders |
| G-A7 progress cards / callbacks / final-answer separation | partial | Projection feeds the existing `item_state` path; interactive callback routing is covered at the store level (ST-6); no live card |
| G-A8 crash behaviour | **real** | Scratch SIGKILL probe and an EOF test (below) |
| SC-1 ST-1..ST-6 | unit, real SQLite | `cards-store-sc1.test.ts` |

## Gateway crash (H-EOF) and residuals

A scratch probe used the real binary with the gateway SIGKILLed:
- The child exits in about 0.1 s.
- With the required list, nothing else is left in its process group.
- Model shells are reaped at about 0.1 s, including backgrounded, TERM-ignoring and `nohup` shells.

The EOF path is also pinned by `app-server-real-binary.test.ts`.

Residuals, recorded and not fixed here:

1. **Incomplete disable list → NW-1 required.** With default features (for example `plugins` on), 0.163.0 starts a marketplace `git fetch`. Its processes outlive the child after a gateway crash; with a stalled network one was alive at 51 s. The fence makes the list load-bearing. If the list is ever incomplete, a persisted process-group registry with a PID-reuse-safe restart sweep (NW-1) becomes required work before enablement. NW-1 is not built.
2. **`setsid`/double-fork escape.** A model command that forks into a new session survives teardown. The exec path has the same exposure: its teardown only targets the launcher's process group. This change does not widen it, and NW-1 would not close it either.
3. **Same-UID inputs and host-administrative layers.** These are as accepted in D-A2(i). The fence narrows the window between the check and the child's read; it does not close it.

Nothing here enables the runtime or cards for a live bot.
