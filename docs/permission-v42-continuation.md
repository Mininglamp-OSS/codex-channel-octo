# V42 endpoint catalog boot continuation

The approved corrected v2 attachment was downloaded through the task CLI before
source edits: 70,457 bytes, SHA-256
`f8bcf1af183fcb69b5c40575d26e21b8a37e7e8fb6720b53e4013924ad078725`.
Its map and source ledger also match their approved hashes. Owner approval in
task comment `93eb4b93-a958-407d-8397-ace2fbf66a64` supersedes that attachment's
historical pending wording only for this exact amendment. V8, PRD2.1, v28 DENY
retention and the separate source/review/deployment/test/acceptance gates remain.

The retained Draft #102 stays on the `ploy-elison` fork, targeting the approved
`main` baseline `5dfde6cfd56621b0fbcf9ec7f310c7caa5135f34`. The preceding head is
backed up at `backup/xin-2795-v42-1486253`. No other repository is edited.

## Implemented source

The concrete main factory now preflights the privately selected catalog identity
before dependency recovery, and the coordinator launcher repeats the read/check
immediately before creating its process. The selected file is read through a
bounded non-symlink fd, with owner/alias/write checks. Raw SHA-256, format, version,
revision and semantics must agree. A path-only cache or an old success is never
used after file replacement.

Private endpoint descriptor **version 2** preserves all v1 fields and requires
`catalog` exactly `{catalog_format,catalog_version,catalog_digest}`. The closed
formats are `permission-release-manifest-v1` and `permission-catalog-package-v2`.
Descriptor v1 retains v1 behavior and refuses an implicit v2 artifact. The digest
must equal the existing private CLI host configuration's `release_sha256`.
For v2 the preflight reads manifest bytes within 65,536 bytes, not a logical
expanded catalog; v1 retains its 8,388,608-byte artifact ceiling.

The selected identity is frozen through bootstrap and each fresh turn binding.
Model fields cannot retarget it. The CLI must still independently verify and
support the **complete** immutable package before its existing authenticated
readiness. Its current-policy checks must name that same supported version/digest.
The endpoint preflight is not a package validator, source-equivalence ledger,
supported allowlist, authorization decision or independent replacement evaluator.

The identity parser leaves inherited v1 null/numeric values and raw payload
strings outside the new packaging scalar domain. Only the shallow v2 manifest
gets canonical packaging-framing checks. Full profile/closure/ownership/selector/
root/file/expansion validation remains with the required independent MCP/server
verifiers. A test caught UTF-8 BOM removal by the decoder; the preflight now
checks the original bytes first. Neither JSON normalization nor a new response,
input, control or business limit is introduced by packaging preflight.
The same regression exposed the control decoder's BOM stripping. It now compares
canonical bytes to the original frame, so a BOM cannot disappear before the
canonicality check; the new regression fails before that fix and passes after it.

CLI host flags/configuration, TLS Hello, all eight control methods, resource
negotiation and the existing base64 chunk/turn-relay protocols are unchanged.
The user path remains Agent → MCP → checked action. No catalog shell workflow,
model-selected file fetch or catalog business tool is added.

## Consumed producer contracts and exact missing agreement

CLI Draft #234 is consumed at `c683c724f1b007a5396d0f10b49cdfda47867b23`:
`docs/permission/contract-manifest-v4.json`, 2,041 bytes, SHA-256
`dddff79aa3438e31b66afb74ef4cb0f88f417577c95adc55a50903cb8f99e766`.
Its endpoint ABI is unchanged (3,923 bytes, SHA-256
`d0b055d6070545c749a08dfb49cabbd7d6fa15758328c111c20d1d881d20c835`).
Server Draft #951 remains `d5ef4b38269b379bac4aa471a6cad06073c563c8`, with the
already verified v3 handoff and v2 remaining-producer map.

The packaging **grammar and exact bounds are now approved**. The old 14 MB shape
and 7.5 MB experiment are historical measurements, not the newly supported
package or an impossibility proof. No new emitted package, supported pin or
semantic migration pair is present at the consumed heads. Do not retain a
superseded missing-grammar-approval blocker.

The minimum versioned producer agreement needed next is:

- **MCP:** state whether existing `release_path` names exact `manifest.json`
  bytes for v2, with `release_sha256` committing those bytes; independently
  validate/support the complete inventory and atomically publish it **before**
  the existing ready record. Supply exact supported pin, complete ledger,
  source-renderer/selector conformance and approved semantic pairs. The current
  `ReadSupportedRelease` still reads a v1 whole artifact and has an empty compiled
  allowlist. The endpoint has not invented extra Hello or ready fields.
  Docs provenance and the docs-search returned-count maximum stay separately open;
  this continuation chooses no new source head or arbitrary count/byte cap.
- **Server:** deliver the versioned `catalog_format` descriptor/schema and the
  approved private v2 manifest/listed-file reads. Preserve eligibility on every
  read, exact `format/catalog_version/catalog_digest/space_id`, inventory-only
  path selection, raw hash/media/length checks and no downgrade. Retrieval and
  full verification belong to MCP/server; endpoint identity checks cannot replace
  them. No v2 discriminator/read contract is delivered by the consumed v3 handoff.

Native original/current/disclosure/body/recipient replay and SQL recovery remain
separate. The unseen-history proof must join the distinct reference domains
without registering history as ingress. Safe reuse requires authenticated epoch/
scope-incarnation and prior-generation adoption in the approved private admit/
bind flow. Actual model/input/command/native send/publication must own the
physical sink under the shared watermark. Existing control checks followed by an
unchecked launch/send are insufficient. Endpoint-owned dependent adapters and
real platform/UID/fs/process/FD/network containment remain unfinished; this
continuation does not transfer or waive them.

## Verification and limits

`npm test -- --maxWorkers=4`: **136 files / 5,431 tests**, including 79 focused
permission tests. Build, lint, all required type checks and locked 0.163.0 runtime
checks pass. New tests include v1/v2 pin mismatch and explicit selection, changed
bytes, duplicate decoded identity, UTF-8/BOM, alias/size restrictions, inherited
null/numeric/raw values, both private descriptor versions and immutable turns.

The actual `c683c724` Go host/relay executable still passes HTTP and stdio
`execute`/`call_op` with the built endpoint consumer, 219,145-byte / 256-Header
core, renewal and closed-capsule rejection. This uses synthetic native/policy/
business receivers and independently recognized deliveries. It proves retained
control/relay behavior, not a new complete v2 package or unseen-history bridge.
The opt-in runner accepts the exact revision as its second argument:

```
node scripts/verify-permission-cli-abi.mjs /absolute/task-local/CLI-archive c683c724f1b007a5396d0f10b49cdfda47867b23
```

Catalog tests deliberately use **identity-only** fixtures, not a permissive
supported registry or fake production provider. Complete stored/pre/post/node/
depth/part/selector and source-equivalence ledgers remain publisher/verifier
deliverables. Supported-package, real native/ACL/recovery and OS acceptance are
**NOT_RUN**. Production activation is disabled. No global configuration,
deployment, formal review, ready conversion or merge occurred. Rollback retains
all journals, keys, epochs, native fences and uncertainty.
