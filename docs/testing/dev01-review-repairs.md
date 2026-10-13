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

## Deep follow-up repair of B-2 and B-3

This section adds to the narrative above. It does not change or replace any
earlier statement, except where it names a rule that replaces an earlier one.

### Namespaces nested in checker types (EG-31 to EG-39)

The earlier `guarded` check walked object-literal ASTs recursively. For a
checker type, though, it inspected only the immediate properties. A boundary
namespace held one level down, as in `x: { a: typeof api }`, therefore escaped
once an assertion erased the static type. Two strict-mode sources from the
review, with no `any`, show this. One uses a dynamic key over
`x as unknown as Record<...>`. The other uses a rest binding over that
asserted value.

A checker type now counts as guarded when a boundary primitive is reachable
from it. The walk covers:

- union and intersection members;
- string and number index signature types;
- type arguments of type references (arrays, tuples, nested arrays, generic
  instantiations) and alias type arguments;
- property types of user-declared object types and mapped types
  (`Record<'a' | 'b', typeof api>`).

Default-library types (`Date`, `Map`, `Promise` and DOM types) retain user
types through type arguments and index signatures; their own members are not
walked. Imported ambient declarations are walked like other user types.

The walk records the types on its current path. A type already on the path is a
cycle and ends that branch, so recursive interfaces and mutually recursive types
terminate. Type-argument, union and alias edges descend into finite structure.
A property or index edge that reaches a symbol already present three times on
the path is an expanding instantiation, such as `Nest<T> { next: Nest<T[]> }`,
and checks its finite declaration graph before cutting. The walk memoizes positive results. It memoizes negative results
only when no cut was involved.

A literal property key that misses on a type with an index signature now
resolves to the index signature's type. Origins therefore survive
`y.slot?.[k]` over `{ [name: string]: { inner: typeof api } }`.

As before, origins pass through assertions, `satisfies`, non-null, `await`,
parentheses, conditionals, `??` and identifier initializers. Fail-closed
results apply only when a boundary origin is reachable.

The new tests and fixtures:

- `namespace-origin-deep` holds the two exact review repros, deeper contextual
  wrappers, arrays, tuples, nested arrays, index signatures (string, nested,
  number and literal-key mapped), recursive, mutual, generic and expanding
  types, rest variants, `Reflect.get` and `for...in` dynamic reads. Each
  yields one `unresolved-boundary-extraction` (EG-31 to EG-33).
- In the same fixture, literal extraction through nested property, array
  element, index signature and asserted types counts exactly once. It
  baselines exactly: matching counts pass, an overstated count is
  `stale-baseline` and an understated count is `unauthorized-call` (EG-34).
  EG-35 checks the full finding list.
- `namespace-origin-deep-negative` holds classified helpers and reads through
  nested types, an unrelated same-named namespace in recursive, mutual,
  generic and expanding types, local objects, library types and the egress
  module. It reports no usages and no violations (EG-36).

All fixture sources pass `tsc --strict` and the repository ESLint config with
`--max-warnings 0`, and none uses `any`. The fixture API stubs reference their
parameters to keep ESLint at zero warnings. The repository scan is unchanged:
10 baseline usages and no violations.

Limits: the walk does not follow function signatures. A namespace returned from
a function-typed property counts once the call result's checker type exposes it
(`typeValue`). Before that, it is not counted. A rest binding fails closed. It
does not carry its source's origin forward, so later reads through the rest
local are not counted separately. When an expanding instantiation reaches the
member cutoff, the finite declaration graph is checked for namespace origins
before cutting. This includes later conditional branches and referenced type
aliases. Such branches are treated conservatively when expansion cannot prove
them unreachable. Resolved mapped selections expose only their selected
properties; omitted write properties are not reintroduced from type arguments.
EG-37 covers a namespace introduced after five generic layers, EG-38 covers a
mapped helper selection, and EG-39 covers an imported ambient wrapper.

### Injective identity encoding (B3-15 to B3-19)

`identityKey` used to join fields with `|` and leave out the segment count, so
distinct tuples could collide. One example is occurrence `oc|extra` with run
`run1` against occurrence `oc` with run `extra|run1`. The key is now the JSON
serialization of the ordered array `[fixture, occurrence, run, kind, ordinal,
index, count]`. That array must be valid: the strings nonempty, the integers
safe and non-negative, and `1 <= index <= count`. A malformed identity has no
key.

A stored marker reconciles only when its key is found and every parsed field,
including the count, equals the expected identity field by field. A capture is
attributed in the same way. Otherwise the capture is `unexpected-attempt`, and
the delivery it might have explained stays `uncaptured-delivery`. An expected
identity that is malformed is reported as `malformed-expected-identity`, a
failing violation. The bounds, explaining-outcome and retry rules are
unchanged.

Tests:

- B3-15 holds genuine positive controls cloned from the ORACLE-07 control
  trace. Each sets the delimiter-bearing identity in the expected identity,
  marker, body, payload and request hashes, and capture fields. One control
  uses occurrence `oc|extra` with run `run1`, one uses run `run1|cron`, and one
  uses JSON metacharacters. Each is evaluated against its own separately
  declared synthetic seal and passes.
- B3-16 changes only the stored marker to occurrence `oc` with run
  `extra|run1`, leaving the expected identity, capture, hashes and seal as
  they were. The result is `unexpected-delivery`. The same applies to shifts
  across the run/kind, reversed occurrence/run and fixture/occurrence
  boundaries. Kind/ordinal/index shifts and empty fields are invalid under the
  marker grammar and are rejected.
- B3-17 shifts captured identities across the occurrence/run, run/kind and
  fixture/occurrence boundaries. None passes: each fails with
  `unexpected-attempt` and `uncaptured-delivery`. A combined stored and
  captured collision also fails.
- B3-18: a captured or expected identity with a string, delimited, empty or
  missing field, a changed count or a zero index cannot pass.
- B3-19: the original ORACLE-07 seal (run7) cannot be borrowed for a run1
  trace. Every check confirms that the seal is not rewritten.

The original ORACLE-01..08 fixtures, `capture-ledgers-v1.json`,
`capture-inventory.mjs` and all earlier tests are unchanged and still pass.

Pre-commit evidence is in `artifacts/deep-precommit/red` and
`artifacts/deep-precommit/green`. That directory is git-ignored. The RED run had
16 failures and 140 passes across 156 tests. The supplemental RED for the
expanding-generic case comes from the HEAD baseline scanner copy. The focused
GREEN run, including `test/oracle/oracle.test.ts`, passed 168 of 168. The later
expansion and ambient audit failures are preserved separately; both also fail
assertions with the unchanged reviewed-head scanner. The final focused run
passes 171 of 171, including the mapped-helper control. Clean-head
gates, mutation and binary runs are left to the integrating executor.
