# ENV-02 isolation and capture handoff

Issue: XIN-2103. Source baseline: `dd1298083d014d8e82376c01edb38a2e6914366f`.
This is a test helper, with a draft-only delivery gate. It implements no App Server product executor, cron feature or SPK assertion. No shared service was deployed or restarted.

## Entry points and boundaries

Use the source checkout after `npm ci` and `npm run build`, Python 3.9+ and Node 22+. The native fixture regression additionally requires a POSIX C compiler available as cc; the gateway package itself does not compile or install that fixture. Python uses Unix directory descriptors, `O_NOFOLLOW`, file locks and process groups; Windows is unsupported. The test scripts, capture proxy and fixtures remain excluded from the published package; main now separately includes its production scripts/check-codex-runtime.mjs. The package contains only three opt-in runtime seams and a minimal typed reader over the existing supported Bot API sync endpoint.

- `src/config.ts`: test profile config-path switch; the exported default remains unchanged.
- `src/index.ts`: watcher uses the same selected path as initial loading and reloads.
- `src/agent-bridge.ts`: pinned executable override only after full profile-path validation; managed runs keep the JSONL proxy and pin its owned child, preserving cancellation/stop proof. Default constructor options are unchanged.
- `src/octo/evidence.ts`: strict authenticated paginated readback, separate from the existing best-effort history helper.
- `scripts/test_profile.py`: start/status/stop/cleanup, protected-file provisioning and bounded capture/smoke adapters.
- `scripts/guarded_child.py`: profile-owned child group terminates after parent EOF, crash or deadline.
- `scripts/capture_proxy.mjs`: independent REST attempts and WS frame metadata, with protected append-only evidence.
- `scripts/capture_smoke.mjs`: supported registration, WKSocket CONNACK, membership/target verification and readback.
- `scripts/profile_smoke.py`, `scripts/test_profile_test.py`, `scripts/check_profile_compat.mjs`: reproducible local evidence.

No DEV-01 branch is required. The seams above are independently reviewable. DEV-01 retains ownership of the SR harness, fixture decoration, oracle and product assertions; this helper supplies their external capture/readback transport rather than duplicating them.

## Secure profile preparation

Choose an existing canonical absolute base directory outside shared homes, the checkout, CODEX_HOME and trusted configuration roots. Its owner must be the current user and mode exactly 0700. Profile names must match `test-<lowercase-slug>`; production/default names, traversal, symlink ancestors and shared/trust-anchor overlap are rejected. Use a canonical path such as `/private/var/...` rather than a symlink alias such as `/var/...` on macOS.

`start` creates separate `home`, `codex-home`, `config`, `data`, `cwd`, `logs` and `bots` directories. A gateway profile derives per-bot `data`, `workspace`, `memory`, `codex-home` and configuration directories under `config/bot-<slug>`. All private directories are 0700 and configuration/credential/evidence files are 0600. The gateway manifest accepts only bot IDs and protected credential file references; credentials cannot override SDK homes, sandbox roots or other settings.

The root and credential files are held by descriptors. Reads reject symlinks, hardlinks, wrong owner/modes, nonregular/oversized files and changes during reading. Parent replacement cannot redirect a held descriptor; runtime path use additionally checks directory identity. Profile ancestors and the approved binary installation must be trusted operator-controlled directories, inaccessible to the bot sandbox. A hostile process with the same OS identity can modify that identity's files; this helper is not an OS privilege boundary.

Do not pass credential values in arguments, environment variables or ordinary attachments. Provision protected files through the owner's approved mechanism. Gateway credentials are JSON `{ "botToken": "<protected value>" }`; capture credentials are a separate protected plain-token file. Examples below describe file formats and never provision real credentials.

## Launch and lifecycle

The ENV-01 executable is the actual native file, not its npm symlink:

`/Users/mlamp/service/spk-xin2101/tools/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`

SHA-256: `8eecc8a6d61a7a8d39a9e6dde28553dfb6f0747d0c56b89eda188e0f2e92caea`.

The launcher checks the checksum and requires exact `codex-cli 0.142.3` version output before starting. It inherits only PATH/LANG/TMPDIR and explicitly creates isolated HOME/CODEX_HOME settings. It does not replace the global CLI.

Run in the foreground; start is bounded to 1–300 seconds. Keep the initiating shell attached until the final collected result. A second shell can operate only that named profile through its private control socket and nonce. Saved PIDs never authorize a signal.

```sh
python3 scripts/test_profile.py start --base /approved/private/base --profile test-env01 --codex /approved/native/codex --sha256 <verified-sha256> --seconds 60
python3 scripts/test_profile.py status --base /approved/private/base --profile test-env01
python3 scripts/test_profile.py stop --base /approved/private/base --profile test-env01
python3 scripts/test_profile.py cleanup --base /approved/private/base --profile test-env01
```

`stop` requests bounded teardown; collect the foreground start result before cleanup. `cleanup` refuses a live owner, clears only stale state/socket files, and preserves secrets, evidence and fixtures. It never recursively removes a profile or operates on another profile. Guardian EOF/crash cleanup acts only on its newly created child process group. After a crash, `status` reports stale and cleanup removes stale lifecycle state without signalling its recorded PID.

For a gateway, provision `<base>/test-env01/gateway.json` (0600):

```json
{ "apiUrl": "https://approved-test-host", "bots": [{ "id": "bot-a", "credentialFile": "bot-a-credential.json" }] }
```

Use the same start command with `--gateway-entry /checkout/dist/index.js --node /approved/node`. The profile launcher writes the two-layer configuration, pins the SDK binary seam, and records only log hashes/readiness/exit metadata in `logs/process.json`; raw errors and logs cannot leak credentials into evidence. Use `bots: []` for the harmless idle gateway smoke. Dedicated bot IDs/accounts are required before a real gateway launch. This bounded helper is not a production service supervisor.

## Independent capture and sanctioned readback

Provision `<profile>/capture.json` and the referenced plain-token file at 0600:

```json
{
  "apiUrl": "https://approved-test-host",
  "credentialFile": "capture-token.txt",
  "seconds": 60,
  "expectedRobotId": "owner-provided-test-bot-id",
  "emptyTestBot": true,
  "targets": [{ "channelId": "owner-provided-test-group", "channelType": 2, "lowWatermark": 1, "expectedMemberUids": ["owner-provided-test-member"] }]
}
```

`localTestEndpoint: true` explicitly allows a dedicated loopback HTTP fixture endpoint. Otherwise HTTPS/WSS are required upstream. The proxy binds only to loopback and rejects generic routes, redirects, missing authentication and targets outside the manifest. A configured HTTPS API path prefix is preserved (with trailing slashes normalized); only the sanctioned relative routes and exact refresh query are appended. It does not require an origin-only upstream or resolve leading routes in a way that drops the prefix.

```sh
python3 scripts/test_profile.py capture --base /approved/private/base --profile test-capture --node /approved/node
python3 scripts/test_profile.py smoke --base /approved/private/base --profile test-readback --node /approved/node
```

Capture prints a loopback URL and stays foreground until its bounded exit. Point the dedicated gateway's `apiUrl` at that URL, with the same protected bot credential. Registration rewrites its WS URL to the profile proxy, so both REST and WS flow through independent capture. For smoke/readback, use the printed proxy URL in a separate protected smoke manifest if combined capture is required. Do not register/connect a second process using an active production/shared bot token: connectivity smoke requires an explicitly designated empty test bot.

Each outbound send/edit has an arrival `attempt`, a bounded parsed `request` with raw-body SHA-256/target/key/sender/fixture marker when available, and a response/disconnect `outcome`. Unknown unfinished arrival records survive a capture crash. Ordinals increase within a unique capture session; retain every session when testing restarts. 4xx prewrite rejection is failed; 5xx, disconnect, timeout, malformed/absent confirmation remain unknown. Send confirmation requires a positive signed-int64 message ID, normalized to decimal text from a safe numeric ID or a lossless decimal string/raw int64. Empty, whitespace, fractional, negative, malformed and out-of-range IDs cannot confirm. An edit additionally requires the returned ID to match the requested ID. The pinned edit wrapper does not promise an acknowledgment schema, so an empty response or `{}` remains unknown until a reviewed deployed-server contract/readback verifies it; mismatched valid IDs are retained separately as `observedResponseMessageId`. No ambiguous retry is introduced. WS records contain direction, time, byte count, packet type and a frame hash, never CONNECT credentials or plaintext frames. The tester retains ownership of fixture identities and the all-attempt oracle.

Evidence files are opened under the Python directory anchor and passed by inherited descriptor, without credential arguments. Each invocation requires a new evidence filename: existing files are refused instead of overwritten. Preserve/rename the completed protected evidence before another invocation. Sanitization redacts credential keys, known token values and bearer/bf_/app_/sk- patterns; hashes retain original payload identity. The capture session adds returned IM credentials and nested credential fields before any registration record is emitted, and retains all old values after rotation. The same session secret set covers REST request metadata/markers, response metadata and WS records. Credentials are forwarded to the designated client, not copied into retained evidence.

Smoke validates the empty-bot attestation, expected bot identity, token reference value, API URL, target IDs/types, DM mapping, member inventory, lower boundaries and page-size range before registration or WS construction. Missing/false designation or an invalid locally checkable manifest causes zero network operations.

The typed reader calls the supported `/v1/bot/messages/sync` operation with older-page mode, captures the latest high watermark once, then uses inclusive descending cursors by default, matching the live Bot API observed in the current deployment. Each next cursor is min(page sequence)-1; the initial cursor is exactly the pinned high watermark, so a concurrent high+1 arrival cannot enter the snapshot. Explicit cursorMode: "exclusive" remains available for verified legacy fixtures/deployments and uses high+1 / min(page sequence). The selected mode is recorded in the result; it is never guessed from a partially observed page. It traverses short pages rather than treating them as completion. It preserves int64 message IDs, decodes bounded payloads, exports sanitized bodies/hashes and records every cursor/page. Completion requires both specified boundaries and every sequence between them. HTTP errors, malformed/oversized pages, repeat/nonprogressing cursors, moving watermarks, missing pages, sequence gaps/retention and explicit page-budget exhaustion are incomplete evidence. Deletion/gap reconciliation needs a reviewed server contract; nothing is silently treated as passed.

The pinned sources establish the supported Bot API endpoints. Their history wrappers do not establish deployed-server retention or cursor semantics. Kent and Grace must validate the configured cursor contract, supplied lower boundary, stable high watermark and complete target inventory on the approved deployment before live protocol/SPK acceptance. Synthetic fixtures prove helper behavior only. Existing read-only source authorization remains valid; its protected conversion awaits the reviewed-helper gate. This revision reads no source credentials and makes no live bot/model call. A healthy approved target and dedicated identity/channel inventory remain outstanding.

## Acceptance ledger and tester consumption

Local evidence under `evidence/env02`:

| Acceptance | Evidence / status |
|---|---|
| Default config and package compatibility | `compatibility.txt`: serialized default config/path/zero-bot output byte-identical to dd12980; unchanged package name/bin/files; old history behavior untouched |
| Regression assertions red before green | `red-config.txt`, `red-isolation.txt`, `red-readback.txt`, `red-capture.txt`: pinned-source/config or intentionally unsafe initial helper scaffolds; `red-controls-*`: additional deliberate negative controls; scaffolds are not product implementations |
| Path/security isolation | `isolation.txt`: shared-home/trust overlap, names/traversal, ancestor/file symlinks, hardlinks, mode/owner checks, held-directory parent swap, stale PID and per-bot override refusal |
| Two live isolated profiles | `profile-smoke.json`: different guardian/child PIDs and separate paths; stop A leaves B live; both initialize 0.142.3 and exit 0; idle gateway also starts/stops |
| Crash and cleanup | same artifact: supervisor kill, guardian/Codex exit, stale-state cleanup, no live profile/socket/state, temporary roots removed |
| Independent capture/readback | `capture-fixture.json`, `readback-fixture.json`, `focused.txt`: confirmed/failed/unknown attempts, WS metadata, registration/membership adapter controls, three-page traversal with fixed watermark, cap/gap/moving-page/redaction controls |
| Shared services | `containers-before.txt`, `containers-after.txt`: stable 61-container inventory; four previously documented restart loops change automatically; helper uses no Docker mutation or shared process-control operation |
| Build/typecheck/lint/regression/pack | baseline artifacts: 1194 tests / 59 files and 8 Python isolation cases; revised checks under `revision-1/`; release excludes scripts and fixtures |
| Live deployment capture contract | PENDING owner-provided healthy endpoint and dedicated identities/accounts; not replaced by synthetic results |
| Kent/Grace handoff consumption | Baseline consumed: Kent comment `77e560ca-0d4b-4efb-9dee-e19e5f8b306b`, Grace comment `253f7049-75f8-41a0-bd8c-1f3cea8ee641`; acknowledgment does not establish live or formal review acceptance |

## Reviewer revision 1

The replacement PR head amends the original fork commit; final immutable head and evidence links are supplied in the issue handoff and PR description. Earlier artifacts remain historical baseline evidence. Current checks and fixtures are under `evidence/env02/revision-1/`:

| Requested change | Fix and regression evidence |
|---|---|
| P1 session-secret redaction | Retain registered/rotated IM and nested credentials before emitting metadata; REST client keys/DLY markers and WS frames are exercised across two registrations. `rotated-credentials-fixture.json` is sanitized. |
| P1 send/edit confirmation | Operation-specific validation, positive signed-int64 normalization, strict send IDs, explicit matching edit IDs; malformed/empty/unverified/mismatched responses remain unknown. Numeric/string/raw int64 and invalid-ID controls are covered. |
| P2 designation before network | Entire locally checkable manifest validation precedes registration/WS; false/missing designation and malformed target/page/boundary fields produce zero calls. |
| Commit-message gate | Replace the original commit message and verify the amended head has no identity trailers; use a command-scoped hook override without changing shared hook files/configuration. |

`red.txt` records 26 failures against the reviewed implementation before fixes; `green.txt` records all 37 focused tests passing afterward. The reviewer's original reproduction now reports normalized numeric confirmation, malformed edit unknown, no retained registration/request credential, and zero registrations with false attestation. Full regression, build/typecheck/lint, eight isolation controls, native two-profile/gateway/crash cleanup, default compatibility and pack exclusion are rerun for the revision. PjM must obtain a fresh formal verdict on the replacement head; no prior approval is carried forward.

Reproduce local checks:

```sh
npm run build
npm run type-check
npm run lint
npm test
python3 scripts/test_profile_test.py
node scripts/check_profile_compat.mjs
python3 scripts/profile_smoke.py --codex /approved/native/codex --node /approved/node --output /protected/evidence/profile-smoke.json
npm pack --dry-run --json
```

Kent and Grace have consumed the baseline handoff; their live-interface prerequisites remain outstanding. PjM: request formal re-review of the amended head and retain ENV-01/SPK-01a/Stage 2 gates. ENV-02 remains blocked on approved live resources and authenticated cursor/high-watermark/retention verification, with its PR draft. No merge/deployment is authorized by the local revision evidence.

## Current review follow-up (main integration)

The branch now incorporates main `ba6eb03` and preserves its default JSONL proxy, safe diagnostics and resume/cancellation safeguards. An explicitly isolated pinned executable remains opt-in. Historical evidence above is unchanged and does not certify this revision.

The capture proxy accepts and forwards only the supported registration query `?force_refresh=true`; rotation coverage calls the package's real `registerBot` API. Rejected routes, methods, queries, credentials, bodies and targets emit a refusal record without forwarding. Query values are omitted from evidence. Unknown registration string fields and nested credentials are retained for redaction until capture ends. The smoke adapter uses the same credential retention and protected-descriptor checks, and records invalid manifest refusal before network activity. Half-set profile configuration and unsupported platforms receive explicit diagnostics.

Local validation: 1269 Vitest tests across 62 files, eight Python isolation cases, typecheck, lint, build, default-config compatibility and npm pack dry run passed. New proxy/smoke regressions produced 14 failures against the previous implementation. Packaging excludes scripts/evidence and includes an executable JSONL proxy. The macOS test fixture resolves the system temporary-directory symlink; runtime symlink rejection is preserved.

These are local synthetic checks. Dedicated live identity/channel inventory and authenticated cursor/high-watermark/retention acceptance remain outstanding. Path-based profile checks still assume protected directories and do not establish a boundary against a malicious process running as the same OS user. Keep the PR draft pending fresh review and live prerequisites.


## PR #19 RC follow-up integrated with main f3ca765 (2026-10-19)

The older evidence directories and revision-1 checksums are historical receipts and have not been rewritten. Their old test counts, old package exclusions and old head claims do not certify this revision. Latest validation is reported in the PR follow-up; no protected credentials or live owner inventory were provisioned for it.

Review reconciliation:

| Finding | Current resolution |
|---|---|
| Registration query/refresh rejected silently | Existing branch fix retained: allow exactly ?force_refresh=true on registration, forward it, test via real registerBot wrapper; refusals emit a fixed record without query values |
| Nested/unknown registration credential strings leak | Existing shared retainCredentials and descriptor validator retained; new smoke invariant echoes nested, array and unknown credential strings into public metadata/readback and verifies all remain redacted |
| Invalid readback identities reported complete | Canonical positive signed-int64 validation now applies to both the high-watermark probe and every page; safe numerics normalize and raw int64 wire values survive via parseOctoJson |
| Configuration mutated before owner.lock | run acquires a validated regular single-link owner lock before any directories/probes/credential writes; holds it through teardown and releases on failure; losing-start regression asserts all existing file bytes and top-level inventory unchanged |
| Shared-home overlap guard survived mutation | Explicit same-root, descendant and ancestor refusal expectations added, before filesystem traversal |
| Pinned executable guard survived mutation | Direct actual bridge regressions cover absent and half-configured profiles; an installed SDK/proxy fixture validates managed pinning and stop proof |
| Inherited smoke descriptors / invalid FD order | Shared validator already checks integer/FD range before fstat; both adapters invoke it before reading protected descriptors |
| Half-set switches/platform diagnostics | Preserve explicit two-switch and POSIX errors; TS path checks remain application-level checks, not a same-UID adversary boundary |
| Readback/plain-string payload or deletion gaps | Reader supports object or encoded-JSON payloads only; unrecognized payloads fail closed. Strict contiguous sequence policy detects incomplete evidence under this contract, but does not prove a server forbids legitimate deletion gaps; live protocol acceptance remains gated |
| Evidence reader ships while scripts do not | Intentional opt-in library entry dist/octo/evidence.js for source/testing consumers; no gateway startup import or automatic network activity. Test helpers remain outside tarball |
| Prohibited trailer | Historical replacement removed the trailer; this follow-up does not rewrite reviewed history or add a co-author trailer |

Default configuration byte comparison is now against integrated main f3ca765 rather than superseded dd12980. It includes the current recovery-validation dependency graph. Isolated test fixture runs use no model/provider calls, no shared service writes and no production restarts. The ENV-01-only launcher remains explicitly pinned to CLI 0.142.3; current SDK 0.163.0 compatibility is separately tested through the managed synthetic CLI fixture, not represented as a rerun of the unavailable historical native binary.

The PR remains draft. Live identity/channel inventory, real refresh/WS protocol, cursor inclusion, retention/deletion contract, and native 0.142.3 profile-smoke prerequisites still require their dedicated acceptance environment. This patch fixes code review defects; it does not claim those live gates are passed.

CI follow-up: build checkout fetches full history so the pinned-main configuration comparison can read f3ca765. The first hosted run exposed the previous shallow checkout limitation; its failed attempt remains historical and is not counted as passing validation.


## Local installed-package acceptance follow-up (2026-10-19)

A dedicated native CLI 0.142.3 was subsequently installed in a separate test directory and verified by version/hash. Native two-profile initialization, stop-one/keep-other, zero-bot gateway, supervisor-crash guardian/native-child teardown and stale-state cleanup now pass locally. The actual npm-installed gateway with SDK/native CLI 0.163.0 also starts and stops in an isolated zero-bot profile. A loopback-only installed-package integration traverses real REST and real WKSocket CONNACK through capture, strict three-message readback, forced registration refresh, int64 confirmation and credential-echo redaction; this is protocol-fixture coverage, not live backend acceptance.

The installed gateway rehearsal found an actionable launcher issue: a 109-byte control socket path in the macOS system temporary directory failed only at bind, after directory/probe mutations, and surfaced a generic refusal. start now preflights the encoded full control.sock path at a portable 103-byte maximum (macOS limit including NUL is 104). Oversized paths fail before owner.lock/config/directory/probe work with fixed reason control-socket-path-too-long and maxSocketPathBytes=103, never echoing the path. The ceiling is deliberately conservative on Linux. Choose a shorter canonical base, e.g. a private directory below /private/tmp on macOS; do not bypass symlink checks via /tmp aliases. Boundary/multibyte and installed CLI refusal/no-mutation regressions cover it.

An initial native rehearsal passed /tmp as an executable ancestor; that alias was correctly rejected by the existing canonical-path guard. Using the canonical /private/tmp executable path fixed the test setup; no guard was relaxed. Historical failed test attempts remain in local receipts. No real owner traffic, secrets, token rotation or production service mutation was used by the isolated tests. Live identity/channel and retention/deletion/cursor acceptance remains separate.


## Real Bot API acceptance correction (2026-10-19)

The earlier installed REST/WS integration used a loopback service with an exclusive cursor and root API URL. It did not establish the actual backend contract. User-requested real-backend probes against the existing owner DM found two defects at b22349f: start_message_seq is inclusive, causing the exclusive reader to repeat the page boundary and reject a valid multi-page window; the deployment API base has a path prefix, which capture refused (and its previous URL resolution would discard).

Both are corrected with explicit validated cursor modes and base-prefix preserving forwarding. New regressions cover the observed inclusive multi-page shape, a concurrent high+1 arrival after the watermark probe, explicit exclusive compatibility, invalid modes before network calls, gap refusal, prefix/trailing-slash support for real registerBot(forceRefresh), sync and send. The smoke manifest passes cursorMode through and rejects invalid values before registration.

Actual backend retest of candidate code: direct and capture-proxied readback each returned six contiguous messages in three pages; IDs remained lossless. A single synthetic text message was actually sent through capture to the current owner DM. The real service returned a different client_msg_no, the oracle confirmed the response ID, and the subsequent real paginated readback matched that ID and the exact sent text. No private message payloads, authorization token, host URL or response body were published in test reports.

This real test reused authentication inside the host config loader and did not register, rotate credentials, or open a second WebSocket with the active identity. Startup of the deployed gateway and this conversation independently establish its direct real WS connection; they do not certify the capture proxy's real-backend WS or refresh flow. Those flows, dedicated group inventory, card-edit response contracts and deletion/retention acceptance still need a dedicated empty test identity/channel. Existing emptyTestBot preconditions are not bypassed or falsified. Passing live recent-window readback does not prove every historical sequence is retained or that every deployment uses the same cursor mode.


## Native managed-turn RC correction (2026-10-19)

Jerry's reviews at ad6732a and 3619d37 identify a real blocker not covered by the earlier .mjs fixture: ExecutionScope always invoked Node with its launcher as a script, while the isolated-profile override is a native executable. Native CLI initialization and a zero-bot gateway did not exercise a managed model turn and did not certify this path. The earlier successful script-based managed test must not be read as native-binary acceptance.

ExecutionScope now has an explicit node/executable launch mode. The default paired SDK JavaScript launcher is unchanged (Node plus script plus original arguments). Only an explicitly pinned profile executable selects executable mode; the gateway spawns it directly with the original arguments while retaining the owned JSONL proxy, detached process group, OS child handle, cancellation and independently observed close/group-stop proof. Missing explicit executable in that mode fails closed. No shell or extension/content guessing is introduced, and control credentials are still removed from the child's environment.

The regression compiles a real C executable with the host compiler. It reports the required codex-cli 0.142.3 version, passes the actual Python executable/checksum validator and emits network-free synthetic JSONL. Direct SDK succeeds on both revisions; managed success, native-failure evidence and cancellation/descendant checks fail on the old revision. After the fix all pass, including killing the stubborn native process and its child with confirmed stop proof. The existing .mjs check is now accurately named executable-script coverage. Native fixture tests are included in strict test type-checks; compiled fixtures remain temporary and excluded from npm packaging.

These native execution checks correct the code-level blocker. They do not certify a live model/provider turn under the historical binary or close the dedicated real-backend refresh/WS/group/edit/retention gates. This RC follow-up does not deploy or restart the active shared gateway.
