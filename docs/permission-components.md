# Permission boundary components — XIN-2795

This is the initial component foundation, continued in
[the endpoint handoff](permission-continuation.md). It remains a **partial implementation**, based on upstream `main` at
`5dfde6cfd56621b0fbcf9ec7f310c7caa5135f34`, for
[issue #101](https://github.com/Mininglamp-OSS/codex-channel-octo/issues/101).
Full Stage 1/2 permission enforcement is incomplete. `startBot` selects the
private per-bot managed factory described in the current
[v7 handoff](permission-endpoint-handoff-v7.json) and [v49 continuation](permission-v49-continuation.md). Boot, readiness, relay,
manifest chunks, contributor resolution, same-generation context reuse, and TurnRelayTrust consume the delivered CLI ABI v2 (`29d81e09dc544b9928d94a9123736330d5d0174f`). Endpoint-owned native/containment drivers and OS-level kernel worker isolation are wired (`createNativeEndpointDriver` resolves metadata through `octo-server` `e708d0235f0d0ecb2b2fd3966db9ccf9e0a8054d` v7 routes using existing `WKSocket` transport identifiers with zero `octo-im`/WukongIM modifications), while `octo-server` historical original-visibility/incarnation/restore-fence gaps, production catalog startup composition, and Owner sign-off on A1 constants + `supported_catalog_digest` remain pending. Without
a descriptor, the existing two-argument library path retains legacy behavior.

## Implemented components

`WKSocket.reserveBeforeAck` is a trusted host hook placed before the message
handler and before RECVACK. It receives a frozen transport observation and the
SHA-256 of the exact decrypted payload bytes. These observations do not attest
native message Space, recipient, version, visibility or stream incarnation.
The host adapter must resolve and compare the real native identity before
reserving it. A committed reservation proceeds to the handler and sends RECVACK
only after the handler returns a terminal disposition and `reservation.finish('terminal')`
durably commits to SQLite; a durably terminal duplicate only ACKs; in-flight
(`reserved`), `uncertain`, unavailable, malformed or failed reservations do
neither.
Managed poison-message handling cannot fall back to the legacy ACK-and-drop
path. At most 64 reservation/handler jobs are retained per socket. A reservation
finishing after disconnect becomes uncertain without starting a handler.
Gateway shutdown and credential-refresh retirement collect these jobs before
releasing their ownership; the host adapter must bound its native reads.

`ReplayJournal` uses the existing SQLite adapter, file-backed storage,
`synchronous=FULL`, `BEGIN IMMEDIATE`, a unique delivery key and an explicit
COMMIT before returning a reservation. An enclosing caller transaction is
refused because it would make that return precede durability. Rows contain
HMAC delivery keys, state and checksums. Authenticated metadata counts detect
row deletion; key-version/checksum mismatches and SQLite corruption refuse.
Completion is terminal or uncertain. Under externally established exclusive
recovery ownership, interrupted reservations become uncertain and never create
another turn. Record and file/WAL/SHM byte bounds stop new reservations without
evicting duplicate fences. There is no TTL, compaction or automatic key reset.

`ContextProvenance` keeps the complete generation-wide union of native Header
references, immutable versions and payload hashes. Every derivative must use
that union. Same-generation reuse validates every retained original and obtains
a fresh invocation ID; one invocation exclusively owns the ledger. A denied or
unknown contributor, changed key/recipient/incarnation/epoch, or restart yields
an empty generation with no old native session. Boundary rechecks fence old
handles on failure, including a contributor insertion during asynchronous
validation. The 256-original/1 MiB bounds reject additions without truncating
the union. These local handles are not CapsuleV2 or positive permission grants.
The eventual host integration must actually isolate/drain workers and enforce
these fences at every import, model and publication boundary.

## Shared contracts and remaining dependencies

[permission-component-contract.json](permission-component-contract.json)
records the exact local serialization vector and unchanged approved source
commitments. It defines no capability catalog, policy evaluator or competing
host-control protocol. `shared-contract-v6.json` remains the CLI/endpoint wire
source; the v8 appendix supplies its explicit MC1–MC7 overrides.

The following paths remain **NOT_RUN / incomplete**, with no positive native
or integrated product claim:

| Dependency | Required implementing owner and interface |
| --- | --- |
| Native Header and current authority | Native IM/server owners: `InspectDeliveredHeaderV1` and `ReadCurrentAccessV1`, authoritative original Space/recipient/version and current per-authority read semantics. A WKSocket message ID/uint32 sequence cannot supply the required stream incarnation or native uint64 sequence. |
| Protected history/media/quotes | Native IM/server owners: `ListHistoryHeadersV1`, `IssueHistoryDisclosureV1`, `ReadDisclosedBodyV1`. Content-first sync and mirror/presence rows cannot replace them. |
| Native replay/recovery | Native IM/server/operations owners: `GetReplayCheckpointV1` and `FenceThroughV1`, ACK coupling, externally durable restore fences and exclusive ownership. Local checksums cannot detect a coherent whole-journal rollback. FULL-sync SQLite tests do not establish hardware power-loss durability. No checkpoint compaction is implemented. |
| Coordinator and catalog | CLI sibling XIN-2794 Draft #234 at `3b07d4d2f6c4637f0c389a71fab056ddf91c3965` supplies evaluator/reader components. Its handoff still marks authenticated control/relay, native providers, production enforcement and supported catalog unavailable. The former account blocker is superseded. See the continuation for exact consumed hashes and source locations. |
| Worker containment and relay | Endpoint/native host integration: the complete approved LaunchPlanV1 and private channel, actual locked native configuration precedence, OS isolation, environment/credential exclusions and exclusive turn relay. This macOS development run changes no runtime/provider/global configuration and proves no Linux/macOS/Windows containment profile. |
| Production admission/context/refusal | Endpoint integration after those interfaces exist: Stage 1 before all protected work, all import/store lineage, fresh publication checks, and typed handled refusal using independently verified original-route reply authority. The existing handler is not represented as permission-gated. |

The backend sibling is XIN-2793. Ada-mini/PjM is the next handoff owner for
native/CLI dependency delivery and the eventual independent exact-head reviewer.
This partial Draft PR does not satisfy the task's complete-delivery or review
gate. The continuation records the precise blocker for the authorized final
status transition. No deployment, ready conversion, merge, release or human
acceptance is implied.

## Initial foundation verification

- Red: the new loopback test failed on the pinned source because its reservation
  callback was never called and a duplicate still reached the handler.
- Green: 27 focused tests cover actual encrypted loopback WebSockets and
  file-backed SQLite, two-connection duplicate handling, a writer killed with
  SIGKILL before cleanup, uncertain recovery, checksums/key versions/deletion,
  saturation, UTF-8 length-delimited HMAC bytes, complete contributor unions,
  exclusive ownership, lineage-revision races and epoch/recipient/restart reset.
- Full regression: `npm test` — 131 files, 5,379 tests passed on Node 26.5.0.
- `npm run build`, `npm run lint`, `npm run type-check`,
  `npm run type-check:permission-tests`, existing mention/recovery/continuity
  type checks, and `npm run runtime:check` passed. CI retains its Node 22/24
  matrix and additionally type-checks these tests.
- A fresh headless Chrome profile drove a local synthetic HTTP harness over
  the built components, real loopback socket and SQLite journal. It verified
  no precommit ACK/handler, duplicate suppression, persisted terminal state
  and reset after a denied former contributor. The inspected
  [browser result](evidence/xin-2795-component-smoke.png) is component evidence;
  native authorities, real business traffic and full permission paths were
  not exercised. No V-A–V-E/V-D2 environment was started.

## Migration and rollback

There is no automatic production migration. Explicit `provision: true` creates
only the two journal tables on the caller-supplied local adapter; missing state
without that explicit provisioning refuses. The host must own the database and
key outside worker/capture directories, establish the native recovery fence,
and invalidate old bindings before integrating it. Existing sessions, settings
and policy envelopes are untouched. Rolling back these unused components needs
no data conversion. If a future integration has created reservations, retain its
journal, keys and native fences through rollback; deleting them is not a safe
recovery procedure.
