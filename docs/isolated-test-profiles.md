# Isolated test profiles and capture

These source-checkout tools run bounded, isolated gateway rehearsals and capture/readback checks. They are not a production supervisor and do not change the default gateway configuration. Test scripts and fixtures are excluded from the npm package; the opt-in strict reader is available at `dist/octo/evidence.js` without automatic network activity.

## Requirements

- Install source dependencies with `npm ci`, then run `npm run build`.
- Use Node 22+, Python 3.9+ and a POSIX host. Windows is unsupported: the helpers require Unix directory descriptors, file locks and process groups.
- Native executable regression tests require `cc`; the installed gateway does not compile test fixtures.
- Use trusted private directories, an approved native binary and dedicated test identities for live connectivity tests.

## Secure profile preparation

Choose an existing canonical absolute base directory outside shared homes, the checkout, CODEX_HOME and trusted configuration roots. Its owner must be the current user and mode exactly 0700. Profile names must match `test-<lowercase-slug>`; production/default names, traversal, symlink ancestors and shared/trust-anchor overlap are rejected. Use a canonical path such as `/private/var/...` rather than a symlink alias such as `/var/...` on macOS.

`start` creates separate `home`, `codex-home`, `config`, `data`, `cwd`, `logs` and `bots` directories. A gateway profile derives per-bot `data`, `workspace`, `memory`, `codex-home` and configuration directories under `config/bot-<slug>`. All private directories are 0700 and configuration/credential/evidence files are 0600. The gateway manifest accepts only bot IDs and protected credential file references; credentials cannot override SDK homes, sandbox roots or other settings.

The root and credential files are held by descriptors. Reads reject symlinks, hardlinks, wrong owner/modes, nonregular/oversized files and changes during reading. Parent replacement cannot redirect a held descriptor; runtime path use additionally checks directory identity. Profile ancestors and the approved binary installation must be trusted operator-controlled directories, inaccessible to the bot sandbox. A hostile process with the same OS identity can modify that identity's files; this helper is not an OS privilege boundary.

Do not pass credential values in arguments, environment variables or ordinary attachments. Provision protected files through the owner's approved mechanism. Gateway credentials are JSON `{ "botToken": "<protected value>" }`; capture credentials are a separate protected plain-token file. Examples below describe file formats and never provision real credentials.

## Launch and lifecycle

The launcher requires an explicitly selected native Codex executable, a verified SHA-256 and exact `codex-cli 0.142.3` version output. This test helper's historical runtime pin is independent of the gateway's current paired SDK/CLI version. Supply the actual native binary, not an npm symlink. It inherits only PATH/LANG/TMPDIR and creates isolated HOME/CODEX_HOME settings; it does not replace the global CLI.

Run in the foreground; start is bounded to 1–300 seconds. Keep the initiating shell attached until the final collected result. A second shell can operate only that named profile through its private control socket and nonce. Saved PIDs never authorize a signal.

```sh
python3 scripts/test_profile.py start --base /approved/private/base --profile test-env01 --codex /approved/native/codex --sha256 "VERIFIED_SHA256" --seconds 60
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

`localTestEndpoint: true` explicitly allows a dedicated loopback HTTP fixture endpoint. Otherwise HTTPS/WSS are required upstream. The proxy binds only to loopback and rejects generic routes, redirects, missing authentication and targets outside the manifest. A configured HTTPS API path prefix is preserved (with trailing slashes normalized); only sanctioned relative routes and validated queries are appended. The route/method inventory covers send/edit, registration/refresh, heartbeat, sync, typing, read receipts, group members/mention preferences, group/thread markdown, upload credentials (one nonempty filename) and user info (one nonempty uid). Extra or duplicate query keys are rejected. Channel operations and every group route must match the target inventory. Authenticated upload-credential and user-info endpoints have no channel parameter; user-info lookups are not limited to target UIDs, since group member UIDs can differ. Every forwarded REST request/response is recorded as bounded metadata and hashes; query values and raw bodies are not retained. It does not require an origin-only upstream or resolve leading routes in a way that drops the prefix.

```sh
python3 scripts/test_profile.py capture --base /approved/private/base --profile test-env01 --node /approved/node
python3 scripts/test_profile.py smoke --base /approved/private/base --profile test-env01 --node /approved/node
```

Capture prints a loopback URL and stays foreground until its bounded exit. Point the dedicated gateway's `apiUrl` at that URL, with the same protected bot credential. Registration rewrites its WS URL to the profile proxy, so both REST and WS flow through independent capture. For smoke/readback, use the printed proxy URL in a separate protected smoke manifest if combined capture is required. Do not register/connect a second process using an active production/shared bot token: connectivity smoke requires an explicitly designated empty test bot.

Each outbound send/edit has an arrival `attempt`, a bounded parsed `request` with raw-body SHA-256/target/key/sender/fixture marker when available, and a response/disconnect `outcome`. Unknown unfinished arrival records survive a capture crash. Ordinals increase within a unique capture session; retain every session when testing restarts. 4xx prewrite rejection is failed; 5xx, disconnect, timeout, malformed/absent confirmation remain unknown. Send confirmation requires a positive signed-int64 message ID, normalized to decimal text from a safe numeric ID or a lossless decimal string/raw int64. Empty, whitespace, fractional, negative, malformed and out-of-range IDs cannot confirm. An edit additionally requires the returned ID to match the requested ID. The pinned edit wrapper does not promise an acknowledgment schema, so an empty response or `{}` remains unknown until a reviewed deployed-server contract/readback verifies it; mismatched valid IDs are retained separately as `observedResponseMessageId`. No ambiguous retry is introduced. WS records contain direction, time, byte count, packet type and a frame hash, never CONNECT credentials or plaintext frames. The tester retains ownership of fixture identities and the all-attempt oracle.

Evidence files are opened under the Python directory anchor and passed by inherited descriptor, without credential arguments. Each operation writes `capture-evidence.jsonl` or `smoke-evidence.jsonl` inside the selected private profile. Existing files are refused instead of overwritten; securely move the completed file before repeating that operation. Sanitization omits credential-named or secret-bearing object keys rather than merging them under a shared replacement key, and redacts known token values and bearer/bf_/app_/sk- patterns; hashes retain original payload identity. The capture session adds returned IM credentials, upload credentials and nested credential fields before any registration record is emitted, and retains all old values after rotation. The same session secret set covers REST request metadata/markers, response metadata and WS records. Credentials are forwarded to the designated client, not copied into retained evidence.

Smoke validates the empty-bot attestation, expected bot identity, token reference value, API URL, target IDs/types, DM mapping, member inventory, lower boundaries and page-size range before registration or WS construction. Missing/false designation or an invalid locally checkable manifest causes zero network operations.

The typed reader calls the supported `/v1/bot/messages/sync` operation with older-page mode, captures the latest high watermark once, then uses inclusive descending cursors by default, matching the live Bot API observed in the current deployment. Each next cursor is min(page sequence)-1; the initial cursor is exactly the pinned high watermark, so a concurrent high+1 arrival cannot enter the snapshot. Explicit cursorMode: "exclusive" remains available for verified legacy fixtures/deployments and uses high+1 / min(page sequence). The selected mode is recorded in the result; it is never guessed from a partially observed page. It traverses short pages rather than treating them as completion. It preserves int64 message IDs, requires a non-null object payload (direct or valid bounded base64 JSON object) in both the high-watermark probe and data pages, rejects scalar/array/missing payloads, exports sanitized bodies/hashes and records every cursor/page. Completion requires both specified boundaries and every sequence between them. HTTP errors, malformed/oversized pages, repeat/nonprogressing cursors, moving watermarks, missing pages, sequence gaps/retention and explicit page-budget exhaustion are incomplete evidence. Deletion/gap reconciliation needs a reviewed server contract; nothing is silently treated as passed.

## Managed execution

An explicitly validated profile binary starts directly with the SDK's original arguments. Default gateway runs retain the paired JavaScript launcher through Node. Both modes retain the owned JSONL proxy, process group, cancellation and stop confirmation. This isolation is a test convention, not a security boundary against processes running as the same OS user.

The full encoded `control.sock` path must be at most 103 bytes; longer paths fail before profile/probe mutations. On macOS use a short canonical private base below `/private/tmp`, not the `/tmp` symlink alias.

## Verification

```sh
npm run build
npm run type-check
npm run type-check:recovery-tests
npm run lint
npm test
python3 scripts/test_profile_test.py
node scripts/check_profile_compat.mjs
python3 scripts/profile_smoke.py --codex /approved/native/codex --node /approved/node --output /protected/results/profile-smoke.json
npm pack --dry-run --json
```

The default-config comparison requires Git history containing main commit `f3ca7657f82a069a4b357a6ec6cdc1295c432c05`; shallow checkouts must fetch that history first. `profile_smoke.py` needs the approved native 0.142.3 binary and does not exercise a live provider turn. Compiled native fixtures test managed success/failure and cancellation/descendant cleanup without model calls.

Keep generated results outside the source tree and review their redaction before sharing them. Historical results and validation summaries belong in PR/CI records, not the source directory. Synthetic results do not certify a deployed backend. Real proxy WebSocket/refresh behavior, dedicated group inventory, edit acknowledgments and deletion/retention behavior require separate live acceptance with the designated test identity. Recent-window readback alone does not prove historical retention or every deployment's cursor contract.
