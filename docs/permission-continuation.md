# Endpoint continuation — XIN-2795

Draft #102 remains incomplete and blocked at the production composition boundary.
The original CLI account blocker is superseded. The continuation consumes the
exact delivered contracts below, rather than treating those component PRs as
working native/coordinator services. The base remains upstream `main` at
`5dfde6cfd56621b0fbcf9ec7f310c7caa5135f34`; the prior head is preserved by
`backup/xin-2795-c152cb5` at `c152cb54df8e3fb822288933e39cf6dcad4b9335`.

## New source behavior

- `startBot(config, multi, permissionFactory)` constructs the trusted managed
  endpoint after registration and before opening the native socket. Its real
  gateway callbacks use the pre-ACK reservation hook and managed receive path;
  they do not enter the legacy content/model handler. A failed factory cannot
  fall back. Shutdown collects managed receipts/workers before database close.
- `EndpointPermissionHost` compares native Header/version/payload/recipient
  evidence with the actual delivery, reserves its durable HMAC identity, and
  sequences trigger discovery, private ingress registration, admission, permitted
  input preparation, complete contributor-manifest binding, one-turn relay,
  worker and owned publication. Unknown legacy state gets a clean context.
  Its ports are required trusted implementations, not booleans that grant access.
- `PermissionControlClient` implements the endpoint side of the unchanged
  managed-v2 Hello and closed eight-method control channel over pinned mTLS.
  Frames are bounded, length-prefixed canonical JSON; noncanonical/duplicate
  decoded keys, malformed scalars/UTF-8, unknown envelopes, stale correlations,
  wrong incarnation/version and lost/invalid negotiation close without fallback.
  A bounded serial queue snapshots requests before waits. All seven non-Hello
  methods are available; the class does not implement their coordinator side.
- Typed refusals are closed records with the four exact fixed texts. The host
  consumes its handled state before one bounded original-route attempt, with
  no legacy generic failure or alternate recipient. Ordinary worker/publication
  failures remain uncertain instead of being relabelled permission denials.
- `preparePrivateWorker` pins executable bytes and stages a private generation
  home/working directory with only explicit static instructions and one HTTP or
  stdio relay. `queryAgentEvents` accepts this host-only plan, excludes inherited
  environment/operator environment overlays, legacy memory, extra directories,
  old resume IDs and automatic retry. The gateway retains the real child handle;
  execution-control keys are stripped before the actual child is spawned.
  Legacy SDK provider credentials/URLs are excluded unless a provider is
  explicitly sealed into the private plan. Platforms without the owned-process
  path refuse this private launch instead of falling back; completing those
  platform adapters remains an owned prerequisite, not a support waiver.

The exact new port/call expectations and consumed byte commitments are in
[permission-endpoint-handoff-v2.json](permission-endpoint-handoff-v2.json).
This is an endpoint composition handoff, not a new public authorization API,
capability catalog, alternative policy evaluator or complete LaunchPlanV1 proof.

## Precise external blockers

| Producer/task | Exact evidence at the consumed head | Required output for integration |
| --- | --- | --- |
| XIN-2794 / CLI MCP-host owner | Draft #234, `3b07d4d2f6c4637f0c389a71fab056ddf91c3965`; `docs/permission/cli-component-contract-v1.json:19–22` explicitly marks production enforcement NOT_WIRED, native/control/relay NOT_IMPLEMENTED and supported catalog NOT_AVAILABLE. `internal/permission/coordinator.go:128–129` says Register is an in-process seam, not native authentication/control, and production MCP never calls it. | A runnable authenticated private listener implementing the full Hello/register/admit/bind/open/renew/close/checkpoint contract, actual CapsuleV2 and one-turn HTTP/stdio relays, supported exact catalog, and coordinator-owned F/new-B/accepted-revision/physical sinks, including model/native publication and local disclosure. Supply exact launch/configuration ABI, keys/peer identities, typed payloads/handles and head/hash. A reusable remote allow response followed by a host fetch/send is not sufficient. |
| XIN-2793 / retained server/native integration owner | Draft #951 advanced during this run to `1fae0db209d656a4b60562e14b71aeb23ad8e87b`. Its exact `contracts/handoff-v2.json` now describes installed association composition and the three-arm native fact-wire adapter; facts mount only with a real installed NativeFactSource. `contracts/remaining-producers-v1.json` names the native message and actual current-writer/recovery primitives still missing. | Bind `NativeFactSource.Read/ValidateCuts` and the real `FencedAuthority` to source-backed `InspectDeliveredHeaderV1`/`ReadCurrentAccessV1`, metadata-first history/disclosure/exact body reads and `GetReplayCheckpointV1`/`FenceThroughV1`. The named native source is `octo-lib v0.0.0-20260811160929-233dd6fcdda6 config/msg.go` behind server sync/webhook paths: its content-first MessageResp has uint32 sequence and lacks original-Space/version/stream incarnation. PjM/Dennis-mini coordinates the retained native implementation owner and actual deployment writer/session/recovery facility. No extra repository or infrastructure mutation is authorized here. |

The CLI contract is **1,436 bytes**, SHA-256
`514d4edd4ce7f22b4f318de79d381cea083f5132fe3327198dc03aef9c104e73`.
The latest server handoff is **2,460 bytes**, SHA-256
`041fa98ab4888c309e91f3ab34c7246dba78622e7ef327203c411a08041ef6c5`.
Its producer contract is **5,153 bytes**, SHA-256
`53f29a0e572cf240584511627236489658089bfcf70598a56216d545730f6a52`.
Both were retrieved through the exact manifest-v2 paths and independently checked;
the native/managed schema bytes remain unchanged. The original server component
head `36ab3dedf9354a7a0cad1a712831c132edd2e08f` was also consumed before this update.
The contracts were fetched from their exact heads and verified. Their partial component
status is not a reason to synthesize native authority or silently enable an
unprotected MCP server.

## Endpoint work still owned here

This continuation does **not** transfer these obligations to the siblings:

1. Compose the concrete managed factory in `main` against the actual native and
   control producers. Preserve existing commands/rate/mention/settings,
   strict/compatible and independent native ACL behavior through that managed
   path. The ordinary bootstrap has not been represented as enforcing Stage 1/2.
2. Complete all mandatory passive/history/media/quote/conversation-markdown,
   memory/derived/store import and publication paths using the real disclosure
   and owned-sink interfaces. The new ports are not native implementations.
   Proven same-generation resume, U/E compatibility, epoch/restart fencing and
   renewal/drain need full production composition. The current integrated host
   path conservatively starts clean and does not claim those compatibility gates.
3. Supply and prove the actual isolation launcher/supervisor: distinct host and
   worker identities, filesystem/mount/process/FD separation, allowed-provider/
   turn-relay-only egress and immutable native distribution. Clean directories,
   read-only SDK flags, executable hashes and a successful native config listing
   are necessary checks, not that OS boundary. No unsupported platform is dropped.
4. Reconcile the concrete `bind_context` manifest descriptor/carrier and relay
   return records with the CLI producer, including the 64 KiB control-frame and
   complete 1 MiB/256-original manifest constraints. No truncation or arbitrary
   supported-capacity claim is made by the current full-manifest test layout.

These remain incomplete source/acceptance duties. The external service/native
ABI above prevents safely constructing the real producer-backed assembly at
these delivered heads; the test producers are deliberately not installed as
production implementations. No full-delivery or premature-review claim follows.

## Actual local verification and limits

`npm test`: **134 files / 5,402 tests passed**. Build, lint, production and
permission/mention/recovery/continuity type checks, and the locked SDK/native
runtime check pass. Fifty focused permission tests include the prior journal,
crash/restart and contributor cases plus the new integrations.

The new tests use actual mTLS sockets and certificates, the real `startBot`
callbacks, real SQLite, real HTTP and child-process stdio JSON-RPC carrying
`execute`/`call_op`, and a synthetic downstream Bot-API receiver. They cover
allowed/denied invocation, unknown authority, changed generation, two-facade
success, capability refusal with zero refused-attempt downstream dispatch,
one fixed refusal and ordinary failure uncertainty. Their coordinator/native/
business producers are synthetic fixtures, not the actual Go CLI or native ACL.

The real SDK/JSONL proxy/owned child test checks environment and instruction/
resume isolation. A separate check runs the **locked native CLI** only for
`mcp list --json` in clean task-local directories and confirms one explicit
HTTP or stdio relay. That check caught JSON object syntax being treated as a
string; the launch encoder now emits actual TOML inline tables. No model-provider
or real business request is made by this probe. It proves configuration loading
on this one installed distribution, not general config/OS containment.

The owned-child regression also caught a synthetic legacy provider key entering
the private child. The corrected path takes provider credentials/URL only from
the explicit private plan and ignores the legacy SDK provider selection there.

A fresh headless Chrome profile requested the local protocol test harness and
received all 23 new test results. The inspected
[browser result](evidence/xin-2795-managed-smoke.png) labels its synthetic scope.
Full native/cross-repository MCP permission acceptance and OS containment remain
**NOT_RUN**. No V-A–V-E/V-D2 environment, deployment, global configuration change,
new runtime/account/member, formal review, ready conversion or merge occurred.

## Migration and rollback

No new production data migration or bootstrap configuration is installed.
The optional trusted factory preserves existing two-argument callers and cannot
be supplied by an MCP argument. The private worker path does not alter legacy
launch behavior. Before any future producer-backed activation, retain the host
journal/key/native fences, persistent epochs and uncertainty through rollback.
Do not delete them or resume old capsules to restore availability. The next
coordination owner is Ada-mini/PjM; the implementing endpoint owner retains the
remaining work listed above. Independent review follows complete source delivery.
