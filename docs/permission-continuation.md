# Endpoint continuation — XIN-2795

The current v49 continuation is [permission-v49-continuation.md](permission-v49-continuation.md)
with [handoff v7](permission-endpoint-handoff-v7.json) (superseding [permission-v45-continuation.md](permission-v45-continuation.md) and [handoff v6](permission-endpoint-handoff-v6.json)). This document records the
preceding ABI integration; its catalog size/approval discussion is historical.
The exact corrected v2 grammar/bounds are now approved, while supported package
and native/physical/containment delivery remain incomplete.

Draft #102 remains incomplete at the native/containment production boundary.
The CLI account and missing-control/missing-relay blockers are superseded.
The required upstream `main` remains `5dfde6cfd56621b0fbcf9ec7f310c7caa5135f34`.
The preceding delivery is preserved at `backup/xin-2795-e460104`.

## Implemented against the new producer

`startBot` selects a concrete managed factory from the private, per-bot
`<baseDir>/<configId>/permission-endpoint.json` descriptor. Absence preserves
legacy behavior. An invalid/unreadable/symlinked descriptor fails startup; missing
adapters cannot fall back. The factory completes before the native socket opens.
Managed startup skips legacy group-context loading, session expiry/recovery,
cwd cleanup and media-CDN probes. No production configuration was installed.

The factory composes authoritative recovery, the durable replay journal, one
owned coordinator boot, pinned mTLS control, managed ingress and required physical
native/worker sinks. Native and containment adapters are compiled trusted
dependencies, never operator-selected modules or JSON permission claims. Neither
real adapter exists in the delivered contracts; production selection fails with
`PERMISSION_NATIVE_AND_CONTAINMENT_BINDINGS_UNAVAILABLE`. Tests explicitly supply
synthetic adapters; none is installed as production authority.

The coordinator launcher verifies the absolute executable/hash, creates a fresh
private boot directory, writes/fsyncs its host config and launches
`mcp serve --permission-config <private-file>`. Only that trusted process receives
the explicitly selected Bot token. Its clean environment excludes ambient task
tokens, credential mode, accounts/profiles, PATH and CLI configuration. The fresh
0600 ready record supplies the coordinator incarnation, verified through pinned
TLS 1.3 Hello. Invalid readiness, early exit and failed negotiation collect the
owned process without restart or alternate service. Process loss fences local
continuations. Boot evidence is private and never reused.

The stdio reply must name the selected CLI executable/hash. Its closed base64url
ticket contains only the configured endpoint and a 64-hex turn bearer. Ordinary
credentials, changed endpoints, extra fields and executable substitution refuse.
HTTP likewise binds the configured HTTPS endpoint and turn bearer. The worker
plan contains one relay and explicit static/provider data, without control keys,
Bot credentials or legacy state.

The manifest hash covers canonical JSON of exactly `context_id`,
`context_generation` and `originals`. Inline metadata is used only if the entire
control envelope fits 65,536 bytes. Larger cores use immutable 32,768-byte
`canonical-json-chunks-v1` slices, fixed total/hash and continuous offsets. Each
accepted length and the final generation are checked. There is no truncation of
the 256-original/1 MiB domain or retry of an ambiguous transfer.

Each admitted turn owns serialized 30-second renewal using its original
ingress/capsule/generation. Malformed, expired or denied renewal aborts the worker
and fences publication. Authentic typed denial retains its one fixed refusal;
ordinary failures remain uncertain. Shutdown drains an in-flight renewal before
capsule close. The 30-minute hard limit is unchanged and never extended.

The actual socket pre-ACK reservation, HMAC journal, native identity comparisons,
complete contributor assembly, clean-generation private worker components and
host-owned process collection remain in use. Components do not prove a complete
native authorization or OS boundary.

## Exact consumed contracts

| Producer | Head and path | Bytes / SHA-256 |
| --- | --- | --- |
| CLI ABI | `14f9b53d3932c532d6424e8783bd94528e5f7fc6`, `docs/permission/endpoint-abi-v1.json` | 3923 / `d0b055d6070545c749a08dfb49cabbd7d6fa15758328c111c20d1d881d20c835` |
| CLI handoff | same head, `docs/permission/cli-component-contract-v3.json` | 4548 / `4b456058c0a9d2f4c7c5743473ae0f467dc79c13521f6ce6723207d91dc44b84` |
| Server handoff | `d5ef4b38269b379bac4aa471a6cad06073c563c8`, `pkg/permissionbundle/contracts/handoff-v3.json` | 2129 / `a2723a2c74665a77e443bf0ddedb479bb5bcc0ff0e3ed5144622deb0427b4091` |
| Server producer map | same head, `pkg/permissionbundle/contracts/remaining-producers-v2.json` | 29231 / `ee1ecf62dc3902113674fb10f02403feb367677950487d1042ce59acbed76f9d` |

The current endpoint handoff is [permission-endpoint-handoff-v3.json](permission-endpoint-handoff-v3.json).
The v2 handoff is historical; its missing-control/relay assertions are superseded.
The shared v6/v8 wire is unchanged. No competing catalog/evaluator is introduced.

## Remaining blockers and retained ownership

1. **Supported catalog — XIN-2794.** The compiled supported-release allowlist is
   empty. The assembly is 14,128,923 bytes against the approved 8,388,608 bound;
   source pagination/byte/selector equivalence is unresolved. Actual
   `ServePermissionHost` refuses before listening. Factory integration does not
   enable a candidate or widen the bound.
2. **Native receipt/content/recovery — native maintainer and XIN-2793; PjM binds
   the serving source and operating owner.** The socket supplies content and a
   numeric sequence, without a recognized delivery reference, immutable original
   Space/version/hash or stable recipient stream/incarnation/u64 cut. The
   `inspect/recover` adapters cannot derive native proof from observations. The
   server producer map requires original/current facts, one-use native disclosure
   and exact body consumption, `GetReplayCheckpointV1`/`FenceThroughV1`, elected
   current SQL and surviving acknowledged-position recovery authority. Ordinary
   history/sync/ACK and a DBR pool cannot supply those guarantees.
3. **Unseen history/import bridge — native producer and CLI; endpoint retains
   the consumer.** `NativeReader.ObservedHeader` accepts only an exact Header
   already resolved through a recognized delivery reference. The token domains
   are distinct. No supplied ABI bridges unseen history; `register_ingress` also
   consumes delivery replay tombstones and is not a history resolver. Thus
   history/media/quote/conversation-markdown, passive context, memory/store and
   derived imports require the actual metadata/disclosure/body/current-use
   producers before their owned adapters can be completed. Ordinary content-first
   helpers or a synthetic provider would violate the approved contract.
4. **Reuse and host physical sinks — shared producer ABI; endpoint retains its
   lifecycle/sink adapters.** Every CLI `admit` allocates a new generation. The
   request has only ingress/proposed context ID; the reply has capsule/turn/
   generation. No prior-generation adoption or epoch/incarnation readback exists.
   The endpoint resets and never relabels/resumes legacy native state. The eight
   methods also expose no physical model-start/native-message/input-disclosure
   operation under the shared accepted watermark. A control check followed by an
   unchecked SDK launch/send is insufficient. `prepareInput/publish/refuse` and
   contained worker execution remain required owned physical sinks; commands,
   read receipts, streams and helpers cannot silently enter legacy paths.
5. **Isolation — endpoint-owned incomplete implementation/acceptance.** Pinned
   executables and clean homes do not provide distinct UID, filesystem/mount,
   process/FD or provider/relay-only network containment. No trusted adapter for
   all supported platforms/distributions is supplied or operationally bound.
   `ContainedWorkerDriver.execute` is not selectable by a JSON flag. Its actual
   implementation/proof remains an endpoint duty, coordinated with the native/
   model physical sink above. No platform is waived and no global security,
   account or runtime configuration is changed.

These are incomplete production obligations, not feature-complete source. The
ABI-dependent boot/carrier/relay/renewal work is implemented now. Remaining
native-dependent operations cannot be implemented by guessing authority,
introducing an evaluator, accepting cached allows or changing the shared protocol
without its producers.

## Verification

The focused suite uses actual TLS, SQLite/crash/replay, gateway callbacks,
HTTP/stdio JSON-RPC, owned SDK children and locked native configuration loading.
New cases cover complete 256-original chunk transfer, offset/generation/size/
abort failures, renewal drain/denial, private boot success/failure, absent real
adapters and executable/ticket substitution.

An opt-in fixture runs the **built endpoint against the actual CLI 14f9b53d Go
control host and relay executable**, using that source's synthetic native/policy
receiver. HTTP and stdio both pass with **219,145 complete core bytes / 256
distinct Headers**, renewal, `execute` and `call_op`, two synthetic business writes
per transport and closed-capsule rejection. The old single-frame request rejects;
chunks succeed. All fixture Headers were independently resolved deliveries, so
this does not simulate a working unseen-history bridge. After `npm run build`:

```
node scripts/verify-permission-cli-abi.mjs /absolute/task-local/CLI-14f9b53d-archive
```

The script checks ABI/host/relay hashes, refuses a checkout, and exclusively adds
its temporary test file to the prepared source archive. It removes that file
after collecting Go/Node/CLI processes. No sibling checkout is edited.

Regression passes: **135 files / 5,417 tests** (`npm test -- --maxWorkers=4`),
including 65 focused permission tests. Build, lint, all required type checks and
the locked 0.163.0 SDK/CLI/native check pass. A fresh Chrome profile passed 38
endpoint cases plus both actual CLI transport cases; the
[screenshot](evidence/xin-2795-cli-abi-smoke.png) was visually inspected.
Real native/ACL, supported-catalog, elected-writer/recovery,
full business and OS containment acceptance remain **NOT_RUN**. No V-A–V-E/V-D2
environment, deployment, global configuration change, formal review, ready
conversion or merge occurred.

## Rollback

Revert Draft commits and leave managed activation disabled. Retain journal keys/
rows, native fences, epochs and uncertainty; never delete them, reuse old ready
records or revive capsules to restore availability. Independent review follows
complete source delivery and its separate acceptance gates.
