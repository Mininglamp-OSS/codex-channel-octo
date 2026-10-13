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

## Follow-up review repair of B-2 and B-3

A follow-up review of the repairs above at
`f356c847eb549006ba1d82230f92953be7864caa` found six counterexamples. Each
now has a regression that failed with an assertion against the unchanged
verifiers. B-1 code and tests, the eight ORACLE fixtures and
`capture-ledgers-v1.json` are unchanged. No production `src/` file changed.
Where this section is stricter than the sections above, it states the
current semantics.

### Namespace origin tracking (EG-19 to EG-30)

The scan now tracks abstract origins (a checker type, an object literal or a
boundary primitive) instead of only the declared type of a destructured
initializer. Origins flow through these forms:

- parentheses, `as`, `satisfies`, `<T>` assertions, `!` and `await`;
- conditional, `??`, `||`, `&&` and comma expressions;
- identifier initializers;
- identifier assignments, including `=`, `??=`, `||=` and `&&=`, collected
  across the program;
- import aliases;
- object literal properties, shorthand properties and spreads;
- nested object binding patterns;
- property access and element access.

Typed parameters and direct initializer casts resolve as before. Assignment
cycles terminate: a node already on the resolution stack contributes nothing,
and only results computed without such a cut are memoized. Property lookup
also tracks the object-spread path, retaining other reachable properties when
a spread revisits an object. EG-27/28 cover guarded and unrelated spread cycles.
EG-30 resolves the value symbol of a shorthand property, so an erased alias
retains its origin when placed in a shorthand object and destructured later.

Property keys resolve only from syntactic constants: string, numeric and
no-substitution template literals, assertions over them and initialized
`const` bindings. An asserted literal type is never trusted as a key. On a
guarded namespace, an unresolved element-access key, computed binding key or
rest binding fails closed as `unresolved-boundary-extraction`. A guarded
namespace that leaves the tracked graph also fails closed. That covers a
call or `new` argument, array element, return, throw, yield, arrow body,
default export, spread, or assignment to a non-identifier target, including
destructuring assignment.

`export * as ns from` the boundary and a local `export { api as alias }` of a
boundary namespace, including an erased local alias (EG-29), are
`unauthorized-reexport`. Each extraction is counted
once: a binding element, a `namespace.export` access, a constant-key element
access, or a direct identifier reference. Later calls through the extracted
local are not recounted. Classified helpers and reads, unrelated namespaces,
local objects and the egress module stay clean. The ten production baseline
references are unchanged.

### Marker identity, explaining outcomes and retry authorization (B3-09 to B3-14)

A stored `fixtureMarker` maps to an expected identity only if three
conditions hold. Its fixture must match. Its bounds must satisfy
`1 <= index <= count`. Its full parsed identity, including the segment count,
must equal the expected identity. Otherwise it is `unexpected-delivery`. The
same check selects the identity in capture reconciliation.

`validCaptureRecord` (`test/oracle/capture-inventory.mjs`) requires these
typed fields:

- nonempty string `fixture`, `run`, `kind`, `occurrence`, `senderUid`,
  `incarnation`, `clientMsgNo` and `target.channelId`;
- integer `requestOrdinal`, `ordinal` and `target.channelType`;
- integer `index` and `count` with `1 <= index <= count`;
- a 64-character lowercase hex `requestBodyHash`;
- a null or valid `serverNormalizedPayloadHash`;
- a known `transportOutcome` (`response`, `prewrite-failure`, `disconnect`,
  `timeout` or `reset`).

Only a `response` carries an integer HTTP status from 100 to 599 and a
nullable nonempty message ID. Other outcomes must have null status and ID.
`clientMsgNo` is now a required capture field. A malformed record makes the
capture inventory incomplete.

A committed delivery can be explained only by a valid matching capture whose
outcome may have committed:

- a 2xx `response`;
- a documented ambiguity: `timeout`, `disconnect`, `reset` or a 5xx response.

1xx, 3xx and 4xx responses (including 403 and 429), pre-write failures and
malformed records cannot explain a delivery, so it is `uncaptured-delivery`.
A nonnull response message ID must equal the read-back message ID. Ambiguity
keeps its documented verdicts. ORACLE-04 stays `unknown` and ORACLE-05 still
fails retry-after-ambiguity.

Before two attempts are compared as a retry, both must be valid records.
Otherwise the pair is `unverifiable-retry`, a failing violation. A missing,
null, empty or malformed retry key, body hash, incarnation, outcome or status
therefore never permits a retry. Deleting both `clientMsgNo` fields from
ORACLE-06 now fails instead of passing. Valid controls still pass with one
permitted retry: the original 429 retry, matching normalized hashes and a
pre-write failure retry. Tests evaluate altered captures against the
unchanged sealed ledger and assert that the ledger was not rewritten.

Pre-commit evidence for this follow-up is in `artifacts/b23-precommit/red`
and `artifacts/b23-precommit/green`. That directory is git-ignored. Clean-head
gate, mutation and binary runs are left to the integrating executor.

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
