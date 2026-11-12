# V50 / V52 Round 2 endpoint continuation — A-B4/A-B5/A-B6/A-B7 blocking repairs, Server `f3cf3a13` & CLI `30a8991c` ABI alignment, and residual classification

This continuation implements the `ACTIVE v50` (`Owner2120905444695117824`), `ACTIVE v52` (`Owner2120917153384140800`), and `ACTIVE 12:51 alignment — CURRENT ROUND 2 ONLY` (`Owner2120982929117974528` / `Owner2120953081876090880`, independent review `XIN-2834` verdict `7827f70f-94e7-4efc-b5b7-da7b7496f2db`, trigger comment `a25ee2e2-6960-4da7-b561-c38541da62ee`) slices on `XIN-2795` (`2f4a34e9-2be3-48ac-99f0-38a30f077acd`) under parent charter `XIN-2323` (`17e81670-5b49-461d-9509-7c22ca127939`).

It repairs the four Round 2 endpoint blocking review findings (`[A-B4]`, `[A-B5]`, `[A-B6]`, `[A-B7]`) on top of the Round 1 repairs (`[A-B1]`, `[A-B2]`, `[A-B3]`, shutdown drain order):
- **Endpoint (`XIN-2795` = `2f4a34e9-2be3-48ac-99f0-38a30f077acd`, Draft #102):**
  builds on `6830c4050ccb7a299114933b7eb6afbea990abb2` (`ploy-elison:xin-2795-admission-context-replay`).
- **Server (`XIN-2793` = `6a92a547-cb82-4c3d-ac6c-8f5529028ba4`, Draft #951):**
  `f3cf3a13a29c3f85be14e4b794d1a0836b54a9dc` (Server Round 2 delivered, advancing from `5c04569dd9bb562629c0cd44c367bab15bafc84f` with `handoff-v9.json` and `contract-manifest-v9.json`).
- **CLI (`XIN-2794` = `229ad215-8526-4a04-8f5b-36f073f81a16`, Draft #234):**
  tested against live head `30a8991c0bbbdfd42399e07dadbb60c74b26c3b4` while `XIN-2794` Round 2 repair (`C-B1r2`/`C-B3`) proceeds on Draft #234.

Draft #102 remains on the `ploy-elison` fork targeting `main` (historical base `5dfde6cfd56621b0fbcf9ec7f310c7caa5135f34`; verified clean merge-tree against live upstream `main` `2f4d0521bcae9e15c008c29e290427de5813e8d2`). No sibling repository or task is modified.

## Round 2 blocking repairs (`[A-B4]`, `[A-B5]`, `[A-B6]`, `[A-B7]`)

1. **`[A-B4]` `stdio` relay ticket `max_response_bytes` acceptance and preservation (`src/permissions/endpoint-factory.ts:966-1020`, `src/permissions/worker-launch.ts:498-531, 569, 596-617, 686-717`).**
   - `checkedTurnRelay` (`src/permissions/endpoint-factory.ts:1006`) includes `'max_response_bytes'` in `allowedTicketKeys` in Go `json.Marshal` lexicographic key order between `'endpoint'` and `'peer_sha256'`, validated by `validRelayMaxResponseBytes` (`1..67108864`, accepting both positive integer `number` and positive integer decimal `string` `/^[1-9][0-9]{0,18}$/`).
   - `preparePrivateWorker` and `encodeGoRelayTicket` (`src/permissions/worker-launch.ts:498-531, 569, 596-617, 686-717`) preserve `max_response_bytes` across staged-CA (`ca_file`) and digest (`ca_sha256`) ticket re-encoding so `octo --turn-relay` retains the per-turn response cap.
2. **`[A-B5]` HTTP `202 Accepted` zero-byte notification acknowledgements (`src/permissions/worker-launch.ts:857, 892-904, 1001-1004, 1107-1113`).**
   - `postHttpTurnRelay` (`src/permissions/worker-launch.ts:1001-1004`) resolves `undefined` when `res.statusCode === 202 && totalBytes === 0` (such as Streamable HTTP `notifications/initialized`).
   - `startTurnRelayBridge` (`src/permissions/worker-launch.ts:1107-1113`) responds with `HTTP 202 Accepted` and `Content-Length: 0` when `postHttpTurnRelay` resolves `undefined`.
3. **`[A-B6]` `history_disclosure` permit validation aligned with `octo-server` `#/$defs/Token` schema (`src/permissions/endpoint-factory.ts:576-581`).**
   - `createNativeEndpointDriver.disclose` (`src/permissions/endpoint-factory.ts:576`) validates `primary.permit` against `octo-server`'s real `#/$defs/Token` pattern (`!/^[A-Za-z0-9_-]{1,512}$/.test(primary.permit)` in `pkg/permissionbundle/contracts/permission-native-facts-v1.schema.json`), accepting `octo-server` `f3cf3a13`'s 43-character base64url HMAC-SHA256 permit without requiring an invented `pmt1-` prefix.
4. **`[A-B7]` Linux `bwrap --unshare-pid` isolation and configured HTTP relay pin propagation (`src/permissions/worker-launch.ts:268-276`, `src/permissions/endpoint-factory.ts:1063-1142`).**
   - `bwrapBaseArgs` in `createIsolatingWorkerLauncher` (`src/permissions/worker-launch.ts:268-276`) includes `'--unshare-pid'`.
   - `checkedTurnRelay` (`src/permissions/endpoint-factory.ts:1063-1142`) propagates and enforces configured `boot.hostConfig` `relay_ca`/`peer_ca`, `relay_ca_sha256`, `relay_cert_sha256`/`relay_peer_sha256`, and `relay_server_name` on HTTP `TurnRelay` (`tls`, `caSha256`, `peerSha256`) even when optional `open_relay` reply fields (`tls`, `ca_sha256`, `peer_sha256`) are omitted, and fails closed if any reply pin conflicts with configured host pins.

## Consumed sibling revisions and exact byte/hash inventory

### Server (`XIN-2793` = `6a92a547-cb82-4c3d-ac6c-8f5529028ba4`, Draft #951)
Head: `f3cf3a13a29c3f85be14e4b794d1a0836b54a9dc` (Server Round 2 delivered)

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `pkg/permissionbundle/contracts/handoff-v9.json` | 15,865 | `4aeec7c60356e98dddafb320652c8c680aa919a306856e9b5215e67751a107d9` |
| `pkg/permissionbundle/contracts/contract-manifest-v9.json` | 3,497 | `73a27422b116a0d8ac54a10fb90510d49c86e7bd66eb3422fc95a975b8cef0a3` |
| `pkg/permissionbundle/contracts/remaining-producers-v7.json` | 4,673 | `15db201703b72e9e8f1afcbc6524d02d6edca019410f99cd2aaa20e8831d0bd3` |
| `pkg/permissionbundle/contracts/permission-native-facts-v1.schema.json` | 30,549 | `bf08d33e87ad1a4726116c97171b008394e6896bba4babf03762914b5ad0e643` |
| `pkg/permissionbundle/native_facts_adapter.go` | 42,518 | `7d00d22a82d73bf73eda1c9b739cff8dcff52e5ede46f16e21cf4a50abc7808a` |
| `pkg/permissionbundle/server_message_facts.go` | 35,536 | `0e51194de11806a47e5df07e28a1ebb5fa93e14ae6be5d816b06ef5f06858d08` |
| `docs/permission-server-convergence-v52-r2.md` | 7,858 | `4c639e81f2d6b04eeaa06948944a504780a79766627123c4e16a5ee7ff8c7f13` |

### CLI (`XIN-2794` = `229ad215-8526-4a04-8f5b-36f073f81a16`, Draft #234)
Tested live head: `30a8991c0bbbdfd42399e07dadbb60c74b26c3b4` (`XIN-2794` Round 2 repair `C-B1r2`/`C-B3` remains in progress)

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `docs/permission/endpoint-abi-v1.json` | 3,923 | `d0b055d6070545c749a08dfb49cabbd7d6fa15758328c111c20d1d881d20c835` |
| `docs/permission/contract-manifest-v5.json` | 2,097 | `d54a11eac89263c9a5ddd3279af03c750ccc1775d2832cbe647eab9d089b411a` |
| `internal/mcp/permission_host.go` | 39,857 | `680b6848baf38014a0a2a837b124f5d66b744e6d3dad549bab746dd02919cb5f` |
| `internal/mcp/permission_relay.go` | 12,893 | `07e67533a5ed670fbf28c37a0021e81981b2912444659d66648d3f801cedb2cf` |
| `docs/permission/catalog-package-v2/manifest.json` | 4,934 | `ecc56c2ab0a2c520ab7e5203d2abab06671daf90c28d69f88fe1de8d154109fc` |
| `docs/permission/source-slot-witness-v5.json.gz` | 12,562 | `0c5da173bd0f53c64562a70a5c5feebc955ad111bbe84ed11f5588c08b4b9c0b` |

## Residual classification (`DELIVER`)

1. **`code defect`:** None open on `XIN-2795` (`[A-B1]`–`[A-B7]` closed).
2. **`sibling synchronization`:** `octo-cli` (`XIN-2794` = `229ad215-8526-4a04-8f5b-36f073f81a16`, Draft #234) Round 2 repair (`C-B1r2`/`C-B3`) is in progress; endpoint Round 2 repair is verified against live `octo-cli` `30a8991c0bbbdfd42399e07dadbb60c74b26c3b4` (accepting both positive decimal-string and positive integer `max_response_bytes` in `stdio` tickets) and `octo-server` Round 2 head `f3cf3a13a29c3f85be14e4b794d1a0836b54a9dc`.
3. **`independent review`:** Independent Round 2 re-review (`XIN-2834` = `46d23689-0cb4-4d33-b488-8d430ae854c3`) on `XIN-2795` Draft #102, `XIN-2794` Draft #234, and `XIN-2793` Draft #951 (`f3cf3a13a29c3f85be14e4b794d1a0836b54a9dc`).
4. **`product decision`:**
   - Owner decision under `XIN-2323` (`17e81670-5b49-461d-9509-7c22ca127939`) / `XIN-2830` (`2fd1cf39-ab4d-4da5-aaa0-75161eb9ae52`) on the already-delivered unapproved memo `4831fa26-b5de-4dc0-a3dc-79477c891f91` (plus report `edd9ad84-f10b-4e1e-9161-19a598bbb153` and overriding addendum `28585cc5-4cc3-47e0-b3a5-17f81ac55b75`).
   - Owner decision under `XIN-2323` (`17e81670-5b49-461d-9509-7c22ca127939`) / `XIN-2794` (`229ad215-8526-4a04-8f5b-36f073f81a16`) on A1 production `ResponseBudgets` default values, A2/A3 status, and pinning candidate semantic digest `15c7ca2bf6df703979df529afbca6828f116b2463b1a818456edfad80bcad799` into `supported_catalog_digest`.
5. **`later deployment or tester gate`:**
   - `octo-server` (`XIN-2793` = `6a92a547-cb82-4c3d-ac6c-8f5529028ba4`) production `ServedCatalogs` startup activation (`RegisterBotPermissionRoutesFromEnv` / `LoadVerifiedCatalogRegistryFromEnv` remain fail-closed `503` until an Owner-approved `supported_catalog_digest` is pinned and configured).
   - Post-approval multi-service staging/deployment and tester gates (`V-A`–`V-E` / `V-D2`).
