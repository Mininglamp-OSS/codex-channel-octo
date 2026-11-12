# V45 endpoint ABI v2 consumption and sibling contract convergence

This continuation implements the v45 directive on `XIN-2795`
(`2f4a34e9-2be3-48ac-99f0-38a30f077acd`) under parent charter `XIN-2323`
(`17e81670-5b49-461d-9509-7c22ca127939`), authorized by PjM triage comment
`2523c1b2-26c1-4c21-9a41-5f83f762a0e8` and trigger comment
`06bf6c81-01bd-43a2-80c6-77175dae2f06`. It consumes the newly delivered sibling
revisions on `XIN-2794` (`229ad215-8526-4a04-8f5b-36f073f81a16`, Draft #234 at
`d39072f8182a28ce2be5884151eb03f16cd205b2`, outcome
`2d89b598-5780-4655-bc2a-0136e5504632`) and `XIN-2793`
(`6a92a547-cb82-4c3d-ac6c-8f5529028ba4`, Draft #951 at
`a4021ad87ebc95cf995e8ca1dabbb2d331b0cee8`, outcome
`92af8833-b853-4278-ba43-b9960303a2cb`), while applying the binding v45 product
and architectural constraints.

Draft #102 remains on the `ploy-elison` fork targeting `main` (historical base
`5dfde6cfd56621b0fbcf9ec7f310c7caa5135f34`; verified clean merge-tree against
live upstream `main` `2f4d0521bcae9e15c008c29e290427de5813e8d2`). The preceding
endpoint head `a3164ded106e06de88f98a6820da4f0d80876dc9` is backed up locally at
`backup/xin-2795-v45-a3164de`. No sibling repository is modified.

## Binding v45 alignment constraints

1. **Zero `octo-im` / WukongIM modifications or tasks.**
   `octo-im` / WukongIM is an external open-source project. No wire, API, code,
   configuration, schema, or service change is requested or required from
   `octo-im`. `createNativeEndpointDriver.inspect` forwards the existing
   `WKSocket` transport fields (`message_id`, `message_seq`, `from_uid`,
   `channel_id`, `channel_type`, `timestamp`, `payload_sha256`) to
   `octo-server` (`/v1/bot/permission-facts/v1`), which resolves authoritative
   message and space metadata from `octo-server` state.
2. **Zero external recovery/election/fence platform prerequisite.**
   Single-active Bot deployment uses existing `octo-server` + endpoint local
   durability (`ReplayJournal` FULL-sync SQLite with `PRAGMA locking_mode =
   EXCLUSIVE`).
3. **Proposal and architect recommendation boundaries.**
   - **A1** (`octo-cli` client-side bounded `--page-all` budget): direction
     accepted; final constants and verification evidence remain open under
     `XIN-2323` (`17e81670-5b49-461d-9509-7c22ca127939`) / `XIN-2794`
     (`229ad215-8526-4a04-8f5b-36f073f81a16`).
   - **A2** and **A3**: remain unapproved (`28585cc5-4cc3-47e0-b3a5-17f81ac55b75`).
   - **Architect comment `7b11211f` (`7b11211f-a3ba-429e-be09-8499f7ac4112`)**:
     visibility/recovery relaxation proposals on `XIN-2830`
     (`2fd1cf39-ab4d-4da5-aaa0-75161eb9ae52`) are kept strictly separate from
     work authorized now. `nativeACL`, `noOBO`, `Prepare-CAS-GET`, and `B` remain
     preserved.

## Implemented endpoint work in v45

1. **`resolve_contributors` control method and `<= 32` batching.**
   `src/permissions/control-client.ts` adds `'resolve_contributors'` to
   `ControlMethod` (8 non-Hello control methods matching
   `docs/permission/endpoint-abi-v2.json`). `src/permissions/endpoint-host.ts`
   resolves `prepared.contributorReferences` via `resolve_contributors` in
   batches of at most 32 (`native_batch_size: 32`) so each reply frame stays
   within the 65,536-byte control frame limit and unseen prior-turn/history
   references are resolved with `purpose: "contributor"` without consuming
   `seenDeliveries` ingress replay tombstones.
2. **`bind_context` `contributor_references` on inline and chunked manifests.**
   `src/permissions/context-manifest.ts` adds `BindContextOptions`
   (`contributorReferences?: readonly string[]`), attaching deduplicated
   `contributor_references` on inline `bind_context` requests or on the final
   chunk (`end === bytes.length`) of `canonical-json-chunks-v1` transfers so
   `PermissionHost.bindContext` resolves unseen contributor headers when
   `pending == false` before verifying `ObservedHeader` and Stage 1 contributor
   intersection.
3. **Same-generation context reuse via `prior_generation` and pre-`admit`
   contributor revalidation.**
   `src/permissions/endpoint-host.ts` revalidates retained contributors via
   `revalidateOriginal` before calling `admit` (resetting `ConversationLineage`
   before `proposed_context_id` is bound if any prior contributor is now denied
   or unknown) and passes `prior_generation: lineage.coordinatorGeneration` on
   `admit`. When `PermissionHost.admit` confirms identical `(owner,
   proposed_context_id, key, scope_incarnation, context_epoch)` on a completed
   prior turn, it reuses the bound generation and the endpoint preserves
   `verifiedResume` across turns.
4. **End-to-end `include_tls_trust: true` and `TurnRelayTrust` (`ca_file`,
   `cert_sha256`, `server_name`) consumption.**
   - `EndpointPermissionHost` requests `include_tls_trust: true` on `open_relay`.
   - `checkedTurnRelay` (`src/permissions/endpoint-factory.ts`) validates
     `relay.tls` (`ca_file`, `cert_sha256`, `server_name`) against
     `boot.hostConfig` (`relay_ca`/`peer_ca`, `relay_cert_sha256`,
     `relay_server_name`) and against the decoded `stdio` base64url ticket.
   - `preparePrivateWorker` (`src/permissions/worker-launch.ts`) reads the
     verified PEM file at `relay.tls.ca_file` (or `caCert` fallback), stages it
     into `<codexHome>/relay-ca.pem` (`0600`), rebinds `ca_file` inside the
     worker's `stdio` `--turn-relay` base64url ticket to `<codexHome>/relay-ca.pem`
     within the 512-character handle budget, sets `SSL_CERT_FILE` and
     `NODE_EXTRA_CA_CERTS`, and exposes `relayTls` (`{ca_file, cert_sha256,
     server_name}`).

## Consumed sibling revisions and exact byte/hash inventory

### CLI (`XIN-2794` = `229ad215-8526-4a04-8f5b-36f073f81a16`, Draft #234)
Head: `d39072f8182a28ce2be5884151eb03f16cd205b2` (outcome `2d89b598-5780-4655-bc2a-0136e5504632`)

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `docs/permission/endpoint-abi-v1.json` | 3,923 | `d0b055d6070545c749a08dfb49cabbd7d6fa15758328c111c20d1d881d20c835` |
| `docs/permission/endpoint-abi-v2.json` | 6,955 | `7f9556d0526cff30ef1c36d53d2457dbc4266b8912722717badebac796ad8909` |
| `docs/permission/cli-component-contract-v6.json` | 8,998 | `8da203c9e6b650f5bc94d81080f4ed7281bd2cc36755ff0027f8e2e6b0b9fe9d` |
| `docs/permission/contract-manifest-v6.json` | 2,612 | `7fbb9cece9dfa384181c2fc272cb6afc7f6667b32712aa2e71c8a1c04615301d` |
| `internal/mcp/permission_host.go` | 37,096 | `b6cf97112fdaa79e86dfa2bd90439b0fbb60bb6dbda1597623e795271bfc055b` |
| `internal/mcp/permission_relay.go` | 8,631 | `1856c7c3bf92490fed33459fe4da3e2c9b6b9d7690a6fbb088f72acd285be7bb` |
| `docs/permission/catalog-package-v2/manifest.json` | 4,934 | `ecc56c2ab0a2c520ab7e5203d2abab06671daf90c28d69f88fe1de8d154109fc` |
| `docs/permission/source-slot-witness-v5.json.gz` | 12,562 | `0c5da173bd0f53c64562a70a5c5feebc955ad111bbe84ed11f5588c08b4b9c0b` |

### Server (`XIN-2793` = `6a92a547-cb82-4c3d-ac6c-8f5529028ba4`, Draft #951)
Head: `a4021ad87ebc95cf995e8ca1dabbb2d331b0cee8` (outcome `92af8833-b853-4278-ba43-b9960303a2cb`)

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `pkg/permissionbundle/contracts/contract-manifest-v5.json` | 6,628 | `d51823e404a4c9e3e2b252f6f33453b9fa5047f1bca0e1ca787397bccf6ec9ab` |
| `pkg/permissionbundle/contracts/handoff-v5.json` | 3,626 | `e72902dc68c60acc4f36344749a971b4fc94e43253da4407365259d64d873384` |
| `pkg/permissionbundle/contracts/remaining-producers-v3.json` | 4,438 | `bfb2857fda2ceef9fe94d4044a55813d3cde4846c73ec345ef204c9244bb2c2f` |
| `pkg/permissionbundle/package_witness.go` | 10,340 | `c19f42f042bccb763aa435123649adde6f795b1bda0e95c1a373384cf4499be4` |
| `pkg/permissionbundle/package_witness_test.go` | 6,954 | `65b460a7cfefc3bc395d1170a295aa534c669ce1e02d57378fe2928c6508d00e` |
| `pkg/permissionbundle/package_graph.go` | 14,290 | `7ea53bf14caf428d899ca3b6a9b21dfe0d8c25a6980e86374903261758b42b68` |
| `pkg/permissionbundle/package_slots.go` | 11,660 | `713ac714e7672ac1edb8bbd1a5327857d7027666bf66597b4aa2312862599a89` |

## Reconciliation of semantic digest `415acc86...` vs `15c7ca2b...`

- **Candidate package & witness bytes are identical across all three heads (`octo-cli` `27b387f1`, `octo-cli` `d39072f8`, `octo-server` `a4021ad8`):**
  - `docs/permission/catalog-package-v2/manifest.json`: `4,934` bytes, SHA-256 `ecc56c2ab0a2c520ab7e5203d2abab06671daf90c28d69f88fe1de8d154109fc` (30 files, `7,823,327` stored bytes).
  - `docs/permission/source-slot-witness-v5.json.gz`: `12,562` bytes compressed, SHA-256 `0c5da173bd0f53c64562a70a5c5feebc955ad111bbe84ed11f5588c08b4b9c0b` (`843,132` bytes gunzipped, SHA-256 `0dac894681aa7f4f8810f5fa5574d68ce071f2a401df4a99da4a92e7a43e7c5b`).
- **Why v44 reported `415acc86598208cbf051c9c08cc47e33e0ec9cd8fe7f9444b48b80f11d95ba21`:**
  In `octo-server` `ff4d43c403083fd059ec2e6ef6e0d6d505228d48`, `pkg/permissionbundle/package_witness.go` had not yet been committed, and `pkg/permissionbundle/package_graph.go` (`13,820` B, SHA-256 `8600ca88aeb0f9e0526c10e82077241f87893f6b476d25c3c66ef7cf76470af7`) + `pkg/permissionbundle/package_slots.go` (`11,037` B, SHA-256 `b85d7ddac1c94cbd47d61041e815c7aa54b2945e682b0657bdd8a5df05c91dcd`) used an earlier `semanticView()` projection schema (`e["content"]`, `selection`, `descriptors`, `rendered` keyed by `cellKey`, `identity_index_sha256`, and `normalize()` rewriting `data_ref`/`value_ref` to `raw_sha256` and inlining `template`/`parameter_truth`). Our temporary v44 witness loader against `ff4d43c4` hashed that pre-convergence `semanticView()` to `415acc86598208cbf051c9c08cc47e33e0ec9cd8fe7f9444b48b80f11d95ba21`.
- **Why `octo-server` `a4021ad8` and `octo-cli` `27b387f1`/`d39072f8` converge on `15c7ca2bf6df703979df529afbca6828f116b2463b1a818456edfad80bcad799`:**
  In `octo-server` `a4021ad87ebc95cf995e8ca1dabbb2d331b0cee8`, `package_witness.go` (`10,340` B, SHA-256 `c19f42f042bccb763aa435123649adde6f795b1bda0e95c1a373384cf4499be4`), `package_graph.go` (`14,290` B, SHA-256 `7ea53bf14caf428d899ca3b6a9b21dfe0d8c25a6980e86374903261758b42b68`), and `package_slots.go` (`11,660` B, SHA-256 `713ac714e7672ac1edb8bbd1a5327857d7027666bf66597b4aa2312862599a89`) converged with `octo-cli`'s `internal/permission/catalog_package_semantic.go` (`2,655` B, SHA-256 `da7eb069cf2044b2feec952d5b757b171d25dd15168b775990743a3f04c107d7`) and `internal/permission/catalog_package_render.go` (`10,277` B, SHA-256 `fd688cf27f1cd9bdbfafff886670bb8542f9264120e8f4d37c93027eabd9bdf0`). Both repositories now compute the exact same semantic digest `15c7ca2bf6df703979df529afbca6828f116b2463b1a818456edfad80bcad799` with zero test-only patches.

## Residual external producer requirements

1. **`octo-server` (`XIN-2793` = `6a92a547-cb82-4c3d-ac6c-8f5529028ba4`) production route & service wiring for `/v1/bot/permission-facts/v1` and `/v1/bot/permission-recovery/v1`:**
   Resolve existing `WKSocket` transport identifiers (`message_id`, `message_seq`, `from_uid`, `channel_id`, `channel_type`, `timestamp`, `payload_sha256`) from `octo-server` authoritative state with zero `octo-im`/WukongIM modifications and zero external recovery/election/fence platform.
2. **`octo-server` (`XIN-2793` = `6a92a547-cb82-4c3d-ac6c-8f5529028ba4`) non-nil `ServedCatalogs` startup composition:**
   Bind the verified `CatalogRegistry` (proven on `catalog-package-v2` + `source-slot-witness-v5.json.gz` with semantic digest `15c7ca2bf6df703979df529afbca6828f116b2463b1a818456edfad80bcad799`) into production server initialization instead of `nil` `ServedCatalogs`.
3. **A1 final constants and verification evidence:**
   Complete the accepted A1 bounded client-side `--page-all` budget constant signoff and evidence under `XIN-2323` (`17e81670-5b49-461d-9509-7c22ca127939`) / `XIN-2794` (`229ad215-8526-4a04-8f5b-36f073f81a16`).
