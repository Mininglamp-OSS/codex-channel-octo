# V49 endpoint continuation — server v7 & CLI v6 handoff consumption and review blocker fixes

This continuation implements the `ACTIVE v49` slice on `XIN-2795`
(`2f4a34e9-2be3-48ac-99f0-38a30f077acd`) under parent charter `XIN-2323`
(`17e81670-5b49-461d-9509-7c22ca127939`), authorized by comment
`9f0b21e9-e8c6-4138-b184-0abd75ea9631`. It consumes the delivered sibling
revisions on `XIN-2793` (`6a92a547-cb82-4c3d-ac6c-8f5529028ba4`, Draft #951 at
`e708d0235f0d0ecb2b2fd3966db9ccf9e0a8054d`, outcome
`9aad196b-2da3-451d-b0a8-a89260a955f9`) and `XIN-2794`
(`229ad215-8526-4a04-8f5b-36f073f81a16`, Draft #234 at
`29d81e09dc544b9928d94a9123736330d5d0174f`, outcome
`c4db4480-4c9a-41b3-b2b0-9f5656b92241` / leader outcome
`a5e830ec-957c-4147-8387-1d7610574d12`), and resolves all concrete code and test
blockers from the current-head reviews on `d007962a7762ec42ae2279c673392121ad630e64`
(`R102-ACK-001` / `ef63d1e4-370f-4f93-8138-7f65c0857804`, GitHub reviews
`5875777773`, `5874446045`, `5873693114`, and `5873227030`).

Draft #102 remains on the `ploy-elison` fork targeting `main` (historical base
`5dfde6cfd56621b0fbcf9ec7f310c7caa5135f34`; verified clean merge-tree against
live upstream `main` `2f4d0521bcae9e15c008c29e290427de5813e8d2`). The preceding
endpoint head `d007962a7762ec42ae2279c673392121ad630e64` is backed up locally at
`backup/xin-2795-v49-d007962`. No sibling repository is modified.

## Binding v49 alignment constraints

1. **Zero `octo-im` / WukongIM modifications or tasks.**
   `octo-im` / WukongIM is an external open-source project. No wire, API, code,
   configuration, schema, or service change is requested or required from
   `octo-im`. `createNativeEndpointDriver` resolves authoritative delivery
   bindings, permission facts, disclosure tokens, and replay fences through
   `octo-server` (`e708d0235f0d0ecb2b2fd3966db9ccf9e0a8054d`) using existing
   `WKSocket` transport fields (`message_id`, `message_seq`, `from_uid`,
   `channel_id`, `channel_type`, `timestamp`, `payload_sha256`).
2. **Zero external recovery/election/fence platform prerequisite.**
   Single-active Bot deployment uses existing `octo-server` + endpoint local
   durability (`ReplayJournal` FULL-sync SQLite with `PRAGMA locking_mode =
   EXCLUSIVE`).
3. **`supported_catalog_digest` remains `null`.**
   Candidate semantic digest
   `15c7ca2bf6df703979df529afbca6828f116b2463b1a818456edfad80bcad799` is verified
   across both `octo-cli` (`29d81e09dc544b9928d94a9123736330d5d0174f`) and
   `octo-server` (`e708d0235f0d0ecb2b2fd3966db9ccf9e0a8054d`), but remains
   unpinned (`supported_catalog_digest: null`) until explicit Owner sign-off on
   the catalog pin and A1 `ResponseBudgets` constants.

## Resolved current-head review blockers and v49 implementation

1. **Post-handler, post-SQLite-commit `RECVACK` and `ProcessingDisposition`
   propagation (`R102-ACK-001`, `5875777773`, `5873227030`).**
   - `WKSocket.onRecv` (`src/octo/socket.ts`) never transmits `RECVACK` before
     `onMessage(msg)` completes with `'terminal'` (or `void` for legacy
     callbacks) AND `await reservation.finish('terminal')` commits durably to
     SQLite, and awaits `ws.send` completion via `sendRawAck`.
   - `ReplayJournal.reserve` (`src/permissions/replay-journal.ts`) returns
     `{ disposition: 'duplicate' }` only when `existing.state === 'terminal'`.
     Rows in `'reserved'` (in-flight) or `'uncertain'` state return
     `{ disposition: 'unavailable' }`, preventing premature `RECVACK` on a
     redelivered frame while the first delivery is still executing or after an
     uncertain failure.
   - `EndpointPermissionHost.handle` / `process` (`src/permissions/endpoint-host.ts`)
     and `OctoGateway` (`src/gateway.ts`) propagate
     `ProcessingDisposition = 'terminal' | 'uncertain'`. If the gateway is
     draining, the socket is stale, or the turn aborts/fails before terminal
     completion or handled `PermissionRefusal`, `'uncertain'` is returned and no
     `RECVACK` is sent.
2. **Linux `bwrap --unshare-net` network namespace isolation (`5875777773`,
   `5874446045`, `5873693114`).**
   - `src/permissions/worker-launch.ts` appends `'--unshare-net'` to the Linux
     `bwrap` arguments whenever `options.allowNetwork === false`, alongside
     `'--unshare-all'`, `'--die-with-parent'`, `'--new-session'`, and read-only
     bind mounts.
3. **Cryptographic `ca_sha256` verification and HTTP relay TLS 1.3 leaf pin
   enforcement (`5875777773`).**
   - `validateTurnRelayTrust`, `checkedTurnRelay`, and `preparePrivateWorker`
     accept and cross-check `ca_file`, `ca_pem`, `ca_sha256`, `peer_sha256`,
     `cert_sha256`, and `server_name` across `relay.tls`, `hostConfig`, and
     decoded `stdio` tickets, computing `SHA-256(relayCaBytes)` and refusing on
     any mismatch against `ca_sha256` before staging `<codexHome>/relay-ca.pem`
     (`0600`).
   - `verifyHttpRelayTlsPin` (`src/permissions/worker-launch.ts`, invoked by
     `createContainedWorkerDriver.execute` in `src/permissions/endpoint-factory.ts`)
     performs a pre-execution TLS 1.3 handshake against the HTTPS turn relay
     using the staged custom CA and `servername`, verifying that the peer leaf
     certificate DER SHA-256 matches `cert_sha256` / `peer_sha256` before
     spawning the worker.
4. **Consumption of `octo-server` v7 native routes and schemas
   (`e708d0235f0d0ecb2b2fd3966db9ccf9e0a8054d`).**
   - `createNativeEndpointDriver.inspect`: calls
     `POST /v1/bot/permission-facts/v1/bind-delivery?space_id=<space_id>` with
     `operation: "bind_delivery"` and the `WKSocket` transport envelope
     (`recipient_bot_uid`, `message_id`, `message_seq`, `from_uid`, `channel_id`,
     `channel_type`, `timestamp`, `payload_sha256`).
   - `createNativeEndpointDriver.prepareInput`: calls
     `POST /v1/bot/permission-facts/v1?space_id=<space_id>` with
     `operation: "history_disclosure"`, `delivery_references`, and
     `contributor_references`, verifying `disclosures[]` before returning the
     turn input.
   - `createNativeEndpointDriver.revalidateOriginal`, `publish`, and `refuse`:
     call `POST /v1/bot/permission-facts/v1?space_id=<space_id>` with
     `operation: "resolve"`, `purpose: "reply"`, and `delivery_reference`,
     checking `header`, `current_access` (`bot_current_read === "allow"` and
     `caller_current_read === "allow"`), and `current_visibility`
     (`bot_original_visible === "allow"` and `caller_original_visible === "allow"`)
     before sending or refusing.
   - `createNativeEndpointDriver.recover`: calls
     `POST /v1/bot/permission-facts/v1/fence?space_id=<space_id>` with
     `recipient_bot_uid`, `space_id`, `stream_id`, `stream_incarnation`, and
     `fence_through_sequence`, validating the returned `checkpoint`.

## Consumed sibling revisions and exact byte/hash inventory

### CLI (`XIN-2794` = `229ad215-8526-4a04-8f5b-36f073f81a16`, Draft #234)
Head: `29d81e09dc544b9928d94a9123736330d5d0174f` (outcome `c4db4480-4c9a-41b3-b2b0-9f5656b92241`, leader outcome `a5e830ec-957c-4147-8387-1d7610574d12`)

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `docs/permission/endpoint-abi-v1.json` | 3,923 | `d0b055d6070545c749a08dfb49cabbd7d6fa15758328c111c20d1d881d20c835` |
| `docs/permission/endpoint-abi-v2.json` | 9,647 | `219f927f2522ac5090ef257d50ca5bf5768055607df028ca6c7ad04de1223cdf` |
| `docs/permission/cli-component-contract-v6.json` | 10,671 | `16e924573297469c56c0346b8b6b023f06a68d5ed2f2e389de2ea1664326b4d5` |
| `docs/permission/contract-manifest-v6.json` | 2,872 | `be8e31a1f19ab4314390fe7767c58a4fbbcf024cb5c76cb13e3fcac15120d83e` |
| `docs/permission/response-budget-ledger-v6.json` | 7,728 | `b7c646f4c73fe62d00450a5fec10d4a0f852f227b1040c8b3c31cf94475c9263` |
| `internal/mcp/permission_host.go` | 39,230 | `48cbb855df1a90835f90115008eb408bf7af8d59683329c4e7f4d132e5142ba1` |
| `internal/mcp/permission_relay.go` | 10,772 | `7200b0f8e2d0ef6e158e71bfdd361707cfc97b30f4d80403ee8074520204ec5c` |
| `docs/permission/catalog-package-v2/manifest.json` | 4,934 | `ecc56c2ab0a2c520ab7e5203d2abab06671daf90c28d69f88fe1de8d154109fc` |
| `docs/permission/source-slot-witness-v5.json.gz` | 12,562 | `0c5da173bd0f53c64562a70a5c5feebc955ad111bbe84ed11f5588c08b4b9c0b` |

### Server (`XIN-2793` = `6a92a547-cb82-4c3d-ac6c-8f5529028ba4`, Draft #951)
Head: `e708d0235f0d0ecb2b2fd3966db9ccf9e0a8054d` (outcome `9aad196b-2da3-451d-b0a8-a89260a955f9`)

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `pkg/permissionbundle/contracts/contract-manifest-v7.json` | 2,127 | `8ae92962d775c09cac86bf617399a950ef6416e80de23f18de33e29df27948f2` |
| `pkg/permissionbundle/contracts/handoff-v7.json` | 15,815 | `0bb6754dbd6de0f66c25bfa02ff5973ff477c64443a84aad7f5bde1b454fc454` |
| `pkg/permissionbundle/contracts/remaining-producers-v5.json` | 4,044 | `31f28c62f96451dc4f8eeed0c61e6c1b952cbaff073e2fd982a26c3047d19bbb` |
| `docs/permission-server-convergence-v46.md` | 8,162 | `986a03f698c3ba223d3bc6d8bad702887b4ef52defa1b9a8470a9ea0c5579c54` |
| `pkg/permissionbundle/package_witness.go` | 10,340 | `c19f42f042bccb763aa435123649adde6f795b1bda0e95c1a373384cf4499be4` |

## Residual external producer requirements

1. **`octo-server` (`XIN-2793` = `6a92a547-cb82-4c3d-ac6c-8f5529028ba4`) historical original-visibility proof and legacy untagged DM `space_id` (`remaining-producers-v5.json`):**
   `ServerMessageFacts` currently returns `"unknown"` for `bot_original_visible` / `caller_original_visible` on historical group/thread messages without a delivery-time permit or persisted per-message membership watermark, and on legacy untagged DMs without an explicit `space_id`.
2. **`octo-server` (`XIN-2793` = `6a92a547-cb82-4c3d-ac6c-8f5529028ba4`) durable authority incarnation and restore-epoch fence:**
   Requires a shared SQL+IM durable authority incarnation and restore fence across backup/restore boundaries.
3. **`octo-server` (`XIN-2793` = `6a92a547-cb82-4c3d-ac6c-8f5529028ba4`) production `ServedCatalogs` composition and Owner sign-off on `supported_catalog_digest` + A1 constants:**
   `RegisterBotPermissionRoutesFromEnv` and `LoadVerifiedCatalogRegistryFromEnv` remain fail-closed (`503`) until Owner sign-off under `XIN-2323` (`17e81670-5b49-461d-9509-7c22ca127939`) / `XIN-2794` (`229ad215-8526-4a04-8f5b-36f073f81a16`) approves the A1 `ResponseBudgets` numbers (`response-budget-ledger-v6.json`) and pins candidate semantic digest `15c7ca2bf6df703979df529afbca6828f116b2463b1a818456edfad80bcad799` into `supported_catalog_digest`.
