# V44 endpoint native/containment/provenance continuation

This continuation applies the XIN-2830 architectural analysis report in comment
`edd9ad84-f10b-4e1e-9161-19a598bbb153` (attachment
`d21a8c3c-4dd9-46da-bc6d-e988deac14f6`, 61,292 bytes, SHA-256
`5382c7b511df84bfa5e6eb712cdb2234591e8f15816a50e3b9f1153dfbcf1fc5`) **together
with** its overriding corrective addendum in comment
`28585cc5-4cc3-47e0-b3a5-17f81ac55b75` (attachment
`b7fb7212-c464-4800-8cb5-0df1b1223fc3`, 16,530 bytes, SHA-256
`3331998a30a2e851dfac7d015e01a8c1c0bda90450b07e258e40b397f9662f23`).
Proposals A1, A2, and A3 remain **unapproved** and are not treated as authorized
architecture. V8, PRD2.1, v28 DENY retention, and the v42 package-v2 amendment
remain in force.

Draft #102 remains on the `ploy-elison` fork targeting `main` (historical base
`5dfde6cfd56621b0fbcf9ec7f310c7caa5135f34`; verified clean merge-tree against
live upstream `main` `2f4d0521bcae9e15c008c29e290427de5813e8d2`). The preceding
endpoint head `afb732b20e63baf8acf06c4726a66e290b98e1b6` is backed up locally at
`backup/xin-2795-v44-afb732b`. No sibling repository is modified.

## Implemented endpoint work in v44

1. **OS-level kernel worker containment (`createIsolatingWorkerLauncher`).**
   `src/permissions/worker-launch.ts` implements `createIsolatingWorkerLauncher`
   using macOS Seatbelt (`/usr/bin/sandbox-exec`) on `darwin` and `bwrap`
   (`--unshare-ipc --unshare-pid --unshare-uts --die-with-parent`) on `linux`.
   The kernel sandbox denies `file-read*` and `file-write*` on protected host
   secret paths (`baseDir`, `stateDir`, `hostHome`, `extraProtectedPaths`) even
   when the child process executes under the same POSIX UID, while permitting
   read/write only in the per-generation `workdir`, `codexHome`, and system temp
   roots. Unsupported platforms or missing kernel sandbox binaries fail closed.
2. **Private relay CA trust staging and optional TLS digest pins.**
   `preparePrivateWorker` writes `relay.caCert` to `<root>/relay-ca.pem` (`0600`)
   after verifying UTF-8, no BOM, `<=65,536` bytes, and optional `caSha256`, and
   injects `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS` into the isolated worker
   environment. `checkedTurnRelay` validates optional `ca_sha256` and
   `peer_sha256` fields on `http` (`https://`) relay replies.
3. **Verified same-generation session continuity (`verifiedResume`).**
   `src/agent-bridge.ts` permits `client.resumeThread(effectiveResumeId, threadOpts)`
   under `privateWorker` if and only if `privateWorker.verifiedResume?.sessionId`
   matches `effectiveResumeId`, continuing to throw `'Unverified private worker
   resume refused'` for any unverified resume attempt.
4. **Per-conversation serialization, `ContextProvenance` lineage, and full
   contributor union in `PermissionEndpointHost`.**
   `src/permissions/endpoint-host.ts` serializes turns per
   `origin\0bot_uid\0space_id\0kind\0id` via `withSourceLock`, tracks
   `ConversationLineage` backed by `ContextProvenance`, accumulates the complete
   contributor union across same-generation turns, and passes `verifiedResume`
   and `bindSession` only when the coordinator `admit` response supplies matching
   `generation`, `scope_incarnation`, and `context_epoch` (5-field `admit`).
   When `admit` returns only `{capsule_id, turn_id, generation}` (3-field `admit`),
   cross-turn session reuse is refused and each turn starts a fresh generation.
   Any admission refusal, provenance conflict, worker error, renewal failure, or
   route invalidation resets the lineage immediately.
5. **Concrete `createNativeEndpointDriver`, `createContainedWorkerDriver`, and
   exclusive `ReplayJournal` locking.**
   `src/permissions/endpoint-factory.ts` provides concrete endpoint-owned driver
   factories (`createNativeEndpointDriver` and `createContainedWorkerDriver`)
   composed by default in `managedPermissionFactory` when `dependencies` is
   omitted, including `SessionRouter` candidate construction, single-attempt
   original-route `publish`, and `<=2s` `refuse` with fresh route revalidation.
   `ReplayJournal` supports `exclusive: true` (`PRAGMA busy_timeout = 0; PRAGMA
   locking_mode = EXCLUSIVE`), enabled in `managedPermissionFactory`.

## Consumed sibling heads and cross-repository verification

- **CLI (`XIN-2794`, Draft #234)**: `27b387f1b767a6e0cc200b8e23d074ad3bd28cc1`
  (superseding stale `c683c724f1b007a5396d0f10b49cdfda47867b23`).
  - `docs/permission/contract-manifest-v5.json`: 4,652 bytes, SHA-256
    `22452f096d0f5f76e661855664eb77aa1a3210b9da95a3cb95d1ef282e39a812`.
  - `docs/permission/catalog-package-v2/`: 30 files, 7,823,327 stored bytes;
    `manifest.json` is 4,934 bytes, SHA-256
    `ecc56c2ab0a2c520ab7e5203d2abab06671daf90c28d69f88fe1de8d154109fc`,
    `catalog_version: "octo-capabilities-v1-xin2748-v4"`.
  - `docs/permission/source-slot-witness-v5.json.gz`: 12,562 bytes, SHA-256
    `0c5da173bd0f53c64562a70a5c5feebc955ad111bbe84ed11f5588c08b4b9c0b`.
  - `docs/permission/endpoint-abi-v1.json`: unchanged 3,923 bytes, SHA-256
    `d0b055d6070545c749a08dfb49cabbd7d6fa15758328c111c20d1d881d20c835`.
- **Server (`XIN-2793`, Draft #951)**: `ff4d43c403083fd059ec2e6ef6e0d6d505228d48`
  (superseding stale `d5ef4b38269b379bac4aa471a6cad06073c563c8`).
  - `pkg/permissionbundle/contracts/contract-manifest-v4.json`: 5,067 bytes,
    SHA-256 `39b138a4f689f3695c087ceab0598b4da74a632ec6276ee159b6c5c586c0f230`.
  - `pkg/permissionbundle/contracts/handoff-v4.json`: 8,285 bytes, SHA-256
    `c226b46007904c37ef5b46f78b587cd734f4ac4ccf8c739f786e87cfe4573791`.

Isolated cross-repository verification executed on unmodified archives of both
sibling heads:

1. `node scripts/verify-permission-cli-abi.mjs <archive> 27b387f1b767a6e0cc200b8e23d074ad3bd28cc1`
   passes `http`, `stdio`, and `https_tls` (`permission.PublicationTLSListener` +
   staged `relay-ca.pem`) with 219,145 complete core bytes / 256 Headers, plus
   `verifyCatalogBoot` on the real `docs/permission/catalog-package-v2/manifest.json`.
2. `octo-server` `ff4d43c403083fd059ec2e6ef6e0d6d505228d48`
   `ReadCatalogDirectory` + `VerifyCatalogPackage` passes on `octo-cli`
   `27b387f1b767a6e0cc200b8e23d074ad3bd28cc1` `docs/permission/catalog-package-v2`
   (30 files, 7,823,327 stored bytes) and `source-slot-witness-v5.json.gz`,
   yielding semantic digest
   `415acc86598208cbf051c9c08cc47e33e0ec9cd8fe7f9444b48b80f11d95ba21`.

## Residual external producer requirements

- **Native IM ingress wire (`WKSocket` / native producer):** `recvPacket` currently
  supplies only 9 public transport fields without a recognized `delivery_reference`
  or native `HeaderV1` (`SpaceID`, `BotUID`, `MessageVersion`, `StreamID`,
  `StreamIncarnation`). Without an injected `inspectHeader` or native wire
  extension, `createNativeEndpointDriver.inspect` fails closed before `RECVACK`.
- **CLI `admit` epoch/incarnation & unseen-history resolution (`XIN-2794`):**
  `PermissionHost.admit` at `27b387f1b767a6e0cc200b8e23d074ad3bd28cc1` returns 3
  fields (`{capsule_id, turn_id, generation}`) and `bind_context` requires every
  Header in `originals` to be pre-registered via `register_ingress`. The endpoint
  supports both 3-field (fresh generation per turn) and 5-field (same-generation
  session continuity with `scope_incarnation` and `context_epoch`) `admit` replies,
  and awaits CLI 5-field `admit` + non-ingress history resolution for unseen
  history imports.
- **Supported catalog allowlist & server runtime composition (`XIN-2794` / `XIN-2793`):**
  `octo-cli` `ReadSupportedRelease` still has an empty `supportedReleaseSHAs`
  allowlist and v1-only boot loader, and `octo-server` production startup still
  passes `nil` `ServedCatalogs`.
- **Native replay checkpoint & fenced SQL writer (`XIN-2793` / native owner):**
  `GetReplayCheckpointV1`/`FenceThroughV1` and single-writer SQL lease fencing
  remain external producer deliverables.
