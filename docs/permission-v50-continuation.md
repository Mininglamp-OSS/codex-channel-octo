# V50 / V52 endpoint continuation — latest 3-head tuple convergence, A-B1/A-B2/A-B3 blocking repairs, receiving-connection TLS & budget evidence, and residual classification

This continuation implements the `ACTIVE v50` (`Owner2120905444695117824`, comment `e98ac4b3-105a-420f-81f0-a20177c61f57`) and `ACTIVE v52` (`Owner2120917153384140800`, Charter comment `32e49395-62f6-4aea-bd5b-4b583797d2a3`, independent review `XIN-2834` verdict `9a49c03b-542a-4223-9ac3-3513fb717752`, trigger comment `f3b841df-c529-43d9-96b7-4f02551a3613`) slices on
`XIN-2795` (`2f4a34e9-2be3-48ac-99f0-38a30f077acd`) under parent charter
`XIN-2323` (`17e81670-5b49-461d-9509-7c22ca127939`). It closes the cross-repository version
skew and repairs the three endpoint blocking review findings (`A-B1`, `A-B2`, `A-B3`) plus shutdown drain order against the exact 3-head tuple:
- **Endpoint (`XIN-2795` = `2f4a34e9-2be3-48ac-99f0-38a30f077acd`, Draft #102):**
  builds on `131dc9c38bfe6813a0a0e9f207398fa06112cb9e` (backed up locally at
  `backup/xin-2795-v52-131dc9c`) and `afd3241073c880319703a8a27daf66ff7507682e`.
- **CLI (`XIN-2794` = `229ad215-8526-4a04-8f5b-36f073f81a16`, Draft #234):**
  `3ef52206809ade6b10fcb6976e4c7ab7c8af69a7` (source outcome
  `3293488e-4d14-4b75-a3a4-951c454b1eac`).
- **Server (`XIN-2793` = `6a92a547-cb82-4c3d-ac6c-8f5529028ba4`, Draft #951):**
  `e708d0235f0d0ecb2b2fd3966db9ccf9e0a8054d` (outcome
  `9aad196b-2da3-451d-b0a8-a89260a955f9`).

Draft #102 remains on the `ploy-elison` fork targeting `main` (historical base
`5dfde6cfd56621b0fbcf9ec7f310c7caa5135f34`; verified clean merge-tree against
live upstream `main` `2f4d0521bcae9e15c008c29e290427de5813e8d2`). No sibling
repository or task is modified.

## Binding v50 alignment constraints (`HOLD` & `RESIDUAL CORRECTION`)

1. **Zero `octo-im` / WukongIM modifications or tasks.**
   `octo-im` / WukongIM is an external open-source project. No wire, API, code,
   configuration, schema, or service change is requested or required from
   `octo-im`. `createNativeEndpointDriver` resolves authoritative delivery
   bindings, permission facts, disclosure tokens, and replay fences through
   `octo-server` (`e708d0235f0d0ecb2b2fd3966db9ccf9e0a8054d`) using existing
   `WKSocket` transport fields.
2. **Zero external recovery/election/consensus/fence platform prerequisite.**
   Single-active Bot deployment uses existing `octo-server` + endpoint local
   durability (`ReplayJournal` FULL-sync SQLite with `PRAGMA locking_mode =
   EXCLUSIVE`). Prior wording that could make "shared SQL+IM durable-fence" look
   like an `octo-im` dependency or external platform mandate is explicitly
   retired.
3. **Original `XIN-2830` memo `4831fa26-b5de-4dc0-a3dc-79477c891f91` is already
   delivered but unapproved.**
   Together with `XIN-2830` (`2fd1cf39-ab4d-4da5-aaa0-75161eb9ae52`) report
   `edd9ad84-f10b-4e1e-9161-19a598bbb153` and overriding addendum
   `28585cc5-4cc3-47e0-b3a5-17f81ac55b75`, ordinary-SQL known restore / manual
   review semantics, historical original-visibility & untagged legacy DM
   history/reference scope (`remaining-producers-v5.json`), and replay identity
   deltas await Owner product decision rather than unapproved code substitution.
4. **`supported_catalog_digest` remains `null` and production allowlist remains
   empty.**
   Candidate semantic digest
   `15c7ca2bf6df703979df529afbca6828f116b2463b1a818456edfad80bcad799` is verified
   across both `octo-cli` (`3ef52206809ade6b10fcb6976e4c7ab7c8af69a7`) and
   `octo-server` (`e708d0235f0d0ecb2b2fd3966db9ccf9e0a8054d`), while
   `MinSerializedRPCBudgetBytes = 1024` and `MaxResponseBudgetBytes = 64 MiB`
   (`67108864`) in `octo-cli` are engineering validation guardrails, not
   Owner-selected production defaults.

## V50 / V52 endpoint updates and latest-tuple verification (`COVERAGE`)

1. **`[A-B1]` Actual worker consuming MCP HTTP path routed through `startTurnRelayBridge` -> `postHttpTurnRelay`.**
   - `startTurnRelayBridge` (`src/permissions/worker-launch.ts`) and `createContainedWorkerDriver.execute` (`src/permissions/endpoint-factory.ts`) start a host-owned per-turn local bridge and rebind `mcp_servers.octo.url` (`http://127.0.0.1:<bridgePort>/mcp` with a per-turn 256-bit bearer token) so every actual MCP HTTP call made by the spawned Codex worker traverses `postHttpTurnRelay`.
   - `postHttpTurnRelay` enforces the staged custom CA (`ca_sha256`/`ca_file`), `servername` (`server_name` SNI/SAN override on `https://127.0.0.1:<port>/mcp`), `checkServerIdentity` leaf certificate DER SHA-256 pin (`cert_sha256`/`peer_sha256`), and client-side `X-Octo-Acquisition-Budget-Bytes` (`Content-Length` pre-check and streaming byte cap, returning a bounded `<= 1024 B` JSON-RPC `-32007` `response_budget_exceeded` replacement error envelope on overflow) on every actual worker request.
2. **`[A-B3]` Linux `bwrap --unshare-net` UDS turn-relay bridge (`bwrap-netns-bridge.cjs`).**
   - `createIsolatingWorkerLauncher` (`src/permissions/worker-launch.ts`) preserves `--unshare-net` when `allowNetwork: false` (`descriptor.worker.provider === null`).
   - When `startTurnRelayBridge` is active, it exposes a private mode-`0600` Unix domain socket (`r.sock`) for both HTTP MCP and `octo --turn-relay` stdio transports, bind-mounts the UDS directory into the `bwrap` sandbox, and starts `bwrap-netns-bridge.cjs` inside the isolated network namespace to forward `127.0.0.1:<relayPort>` over `CODEX_OCTO_RELAY_UDS` while stripping `CODEX_OCTO_RELAY_UDS` and `CODEX_OCTO_RELAY_PORT` before `exec`ing the worker.
3. **`[A-B2]` `createNativeEndpointDriver` aligned with `octo-server` v7 wire envelopes, boolean predicate maps, decimal-string epochs, and `resolve`/`reply`/`reference` shapes.**
   - Validates `octo-server` v7 response envelopes (`schema_version: 1`, `profile_version: 1`, `key`, `request_id`, `read_id`, `observed_at`, 2-element `authorities` array `[{ authority_id, kind: 'sql'|'im', incarnation, position, read_nonce, consistency: 'ack_before_read_start', started_at, completed_at }]`, and `authority_refs`).
   - Requires `message_seq > 0` in `inspect` and parses `binding.proven_predicates` as `octo-server`'s boolean map (`Record<string, boolean>`).
   - Preserves mandatory `bot_original_visible === true` and `caller_original_visible === true` checks in `prepareInput` (refusing when either is in `unknown_predicates` or `false`), formats `context_epoch` as a decimal string, validates `octo-server` v7's `HistoryDisclosureResponse` (`status: 'resolved'`, `permit: 'pmt1-...'`, `payload_sha256`), extracts the invoking turn's input from the bound delivered `WKSocket` frame, and fails closed (`PERMISSION_NATIVE_HISTORY_BODY_CONSUMER_UNAVAILABLE`) if additional historical contributors return metadata-only permits without body content.
   - Uses `operation: 'resolve', purpose: 'admit'` in `revalidateOriginal` with mandatory all-`true` `result.predicates` checks (`verifyResolvedPredicates`).
   - Matches `resolved.reference === deliveryReference` in `publish` and `refuse` and verifies all `reply` predicates are `=== true` (refusing before `sendMessage` whenever any reply predicate such as `bot_current_send` or `dm_bot_to_human_send_relation` is `false`).
   - Removes the unmounted `/v1/bot/permission-facts/v1/fence` call and keeps `recover` explicitly fail-closed (`PERMISSION_NATIVE_RECOVERY_FENCE_UNAVAILABLE`) until Owner decision on `XIN-2830` Decision 1.
4. **Non-blocking shutdown drain order (`src/index.ts:321-327`).**
   - `shutdown` drains `await router.stopTurns()` and `await gateway.stop(activeHandlers)` before `await permissionEndpoint?.stop()`.
5. **Latest CLI `3ef52206809ade6b10fcb6976e4c7ab7c8af69a7` binary/relay
   acquisition, replacement-envelope budget behavior, and denied read/write Journey 3.**
   - Verified against `octo-cli` `3ef52206809ade6b10fcb6976e4c7ab7c8af69a7` with
     `ResponseBudgets` (`MaxAcquisitionBytes: 512`, `MaxPageItems: 10`,
     `MaxPages: 2`, `MaxCumulativeBytes: 1024`,
     `MaxSerializedRPCBytes: MinSerializedRPCBudgetBytes = 1024`).
   - **Journey 3 (Admitted turn denied read + write with zero refused-attempt dispatch):**
     ungranted read (`docs.scene.get`) and write (`docs.scene.edit`) during an admitted turn are rejected across both `execute` and `call_op` with JSON-RPC error `-32007` (`capability_denied`) and `deniedDispatches === 0` at the backend.

## Consumed sibling revisions and exact byte/hash inventory

### CLI (`XIN-2794` = `229ad215-8526-4a04-8f5b-36f073f81a16`, Draft #234)
Head: `3ef52206809ade6b10fcb6976e4c7ab7c8af69a7` (outcome `3293488e-4d14-4b75-a3a4-951c454b1eac`)

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `docs/permission/endpoint-abi-v1.json` | 3,923 | `d0b055d6070545c749a08dfb49cabbd7d6fa15758328c111c20d1d881d20c835` |
| `docs/permission/endpoint-abi-v2.json` | 10,811 | `785342476f15d3d21a9936d370117dfcf6df49aa040d04ebbb21b786453470f9` |
| `docs/permission/cli-component-contract-v6.json` | 11,991 | `aea8d2d11c419a70069c3c26f6f2f27c98e7d865164a178a1f991160ab4b2a3e` |
| `docs/permission/contract-manifest-v6.json` | 2,903 | `37355c4f25f86b5fe438439a4cba0270ec6f0726b5254b6ab40fdb4b8db57e0d` |
| `docs/permission/response-budget-ledger-v6.json` | 8,331 | `7c46334eacc9796c003c6929373033359e0428ed57d74a07244db84a7837e463` |
| `internal/mcp/permission_host.go` | 39,773 | `f9ef0cc4ac84f7c4c712936af9fe5efe86a5fc7baeedd7bfcc011b467abf0e2b` |
| `internal/mcp/permission_relay.go` | 11,359 | `0c2557ec51ec18fcb03e4c35fc2b6b9f48b4d01826db60db5f66b3e1bad5f7ad` |
| `internal/mcp/managed.go` | 13,937 | `32eed0a7fcd50d0851d8ba2671705f9c754ce280cd40e015c1b8bf01c8b34239` |
| `internal/permission/coordinator.go` | 17,862 | `6a5d7c78d76986d642c6cb2a732041a5868abbe18facb99a4dab1ca7dabf9b4e` |
| `internal/permission/runtime.go` | 19,963 | `6357de6ac114fd7a641f45f5ad9c855654b710564b5c5c0ed4f69acf5e3130d0` |
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

## Residual classification (`DELIVER`)

1. **`code defect`:** None open on the converged 3-head tuple (`XIN-2795` Draft #102 + `XIN-2794` `3ef52206809ade6b10fcb6976e4c7ab7c8af69a7` + `XIN-2793` `e708d0235f0d0ecb2b2fd3966db9ccf9e0a8054d`).
2. **`independent review`:** Independent current-head review gate on `XIN-2795` Draft #102, `XIN-2794` Draft #234 (`3ef52206809ade6b10fcb6976e4c7ab7c8af69a7`), and `XIN-2793` Draft #951 (`e708d0235f0d0ecb2b2fd3966db9ccf9e0a8054d`).
3. **`product decision`:**
   - Owner decision under `XIN-2323` (`17e81670-5b49-461d-9509-7c22ca127939`) / `XIN-2830` (`2fd1cf39-ab4d-4da5-aaa0-75161eb9ae52`) on the already-delivered unapproved memo `4831fa26-b5de-4dc0-a3dc-79477c891f91` (plus report `edd9ad84-f10b-4e1e-9161-19a598bbb153` and overriding addendum `28585cc5-4cc3-47e0-b3a5-17f81ac55b75`): ordinary-SQL known restore / manual review handling, historical group/thread `bot_original_visible`/`caller_original_visible` and legacy untagged DM `space_id` history/reference scope (`remaining-producers-v5.json`), and replay identity deltas (with zero `octo-im`/WukongIM changes and zero external consensus/election/fence platform).
   - Owner decision under `XIN-2323` (`17e81670-5b49-461d-9509-7c22ca127939`) / `XIN-2794` (`229ad215-8526-4a04-8f5b-36f073f81a16`) on A1 production `ResponseBudgets` default values (`response-budget-ledger-v6.json`; CLI `1024 B` / `64 MiB` guardrails are engineering validation bounds, not Owner-selected production defaults), A2/A3 status, and pinning candidate semantic digest `15c7ca2bf6df703979df529afbca6828f116b2463b1a818456edfad80bcad799` into `supported_catalog_digest`.
4. **`later deployment or tester gate`:**
   - `octo-server` (`XIN-2793` = `6a92a547-cb82-4c3d-ac6c-8f5529028ba4`) production `ServedCatalogs` startup activation (`RegisterBotPermissionRoutesFromEnv` / `LoadVerifiedCatalogRegistryFromEnv` remain fail-closed `503` until an Owner-approved `supported_catalog_digest` is pinned and configured).
   - Post-approval multi-service staging/deployment and tester gates (`V-A`–`V-E` / `V-D2`).
