# DEV-01 formal review repairs B-1 through B-3

Scope: test harness and invariant infrastructure only, following review
`5507398688` of PR #21 at `afbf400f3ca407f906c8797e48560f955bb1f711`.
The authoritative milestone manifest and ratified amendment are unchanged.

## Milestone selections

`scripts/manifest/selection.mjs` supplies the schema used by lint and evaluation
for M1, M2, M3-dispatch and M3-G6. Unknown keys, malformed/empty lists,
unsupported fields and omitted mandatory cases cannot approve a milestone.
M1/M2 evidence needs nonempty verified manifest/head/profile provenance and a bound
procedure and evidence oracle. Own-property lookups exclude prototype values.

M3 descriptors are structurally checked and reported as not ready. Conditional
cases remain pending until reviewed item-level selection/profile binding is
implemented. This harness does not authenticate owner drop-all decisions:
caller flags, source labels and look-alike dispositions cannot waive M3 items.
An actual exception needs an externally authenticated owner decision and a
separately reviewed verifier; no such decision is claimed by these repairs.

## Namespace boundary extraction

The egress scan resolves object binding properties on their namespace's type,
including shorthand, renamed bindings, typed parameters and re-export chains.
It counts a binding extraction once, consistently with `const f = namespace.f`;
binding declaration names and local alias invocations are not additional sites.
Rest and nonliteral computed extraction of a guarded namespace fail closed.
Classified helpers, unrelated namespaces and authorized egress modules retain
their permitted behavior. The ten baselined production references are unchanged.

## Independent capture inventory

`evaluateDelivery(trace, captureInventory)` requires a separate sealed inventory
from the independent capture proxy/tester. Complete channel read-back alone
cannot establish complete outbound captures. Omitting the second argument
leaves the result pending unless an observed violation already proves failure.

The v1 inventory has these fields:

| Field | Meaning |
|---|---|
| version | `capture-inventory-v1` |
| source | `independent-capture-proxy` or `independent-tester-synthetic` |
| fixture | Exact tester fixture nonce |
| sealed | True only after closing the capture run/window and pagination |
| declaredAttemptCount | Collector counter independent of the supplied capture array |
| declaredPageCount, firstCursor | Collector pagination count and initial cursor |
| pages | Cursor/next chain with independently recorded request ordinals |
| windows | Run/process incarnation, first/last ordinal and attempt count |

Every capture must reconcile with exactly one declared run/process window and
with the unique ordinal inventory. Counts, cursor chains, overlaps, ordinal gaps,
scope mismatches and incomplete records prevent approval. The collector's
counter must not be recomputed from a lossy or filtered `trace.captures` array.
Each stored message also needs a captured attempt with matching logical identity,
sender, target, segment count and payload hash; a nonnull response message ID
must match read-back. Pre-write failure and 429 attempts do not explain a
committed message. Host receipts never supply or replace this inventory.

This is a trusted-input contract, not cryptographic authentication. A live
adapter must obtain the inventory through its independent collector's trusted
route, rather than accept a host-created object that merely claims the source
label. Live collection is outside DEV-01. `capture-ledgers-v1.json` independently
declares the ordinal windows for the frozen synthetic scenarios; it is not a
live network attestation. The eight original ORACLE JSON fixtures are unchanged.
Tests supply the separate ledger and mutate only captures or ledger defects.

Zero attempts can be complete only with a separately sealed zero-count inventory.
A suppressed/no-delivery scenario may then pass; a stored delivery without a
capture still fails reconciliation. Incomplete evidence never hides a known
duplicate/retry violation. Fully accounted ambiguity remains `unknown`.

## Evidence qualifications and integration

Original mutation M07 may be killed by ENOENT when the injected wrong nonce
logic removes the lock. The generic runner proves an executed non-load-error
failure, not that every kill is an AssertionError. Its twelve mutation controls
are local rerun evidence; the workflow does not enforce that command.

The previously preserved filesystem-watcher miss remains an intermittent
filesystem/timing test observation with independent and CI green runs. Those
runs do not establish its underlying cause or prove it can never recur.
No watcher test is relaxed. Upstream conflicts are left for separately
authorized integration; pinned-head green checks are not merge-integration proof.
