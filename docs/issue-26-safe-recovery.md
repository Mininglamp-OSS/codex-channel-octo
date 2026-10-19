# Safe failure handling and bounded pre-execution recovery (#26)

Integrated onto main `7dff464` with #37 diagnostics and #40 session continuity. The original analysis is in issue #26 and its comments. This is the implemented runtime policy, rather than a claim that all inference outages are solved.

## Behavior

- Diagnostics use closed stage/category/source/evidence snapshots and a local diagnostic ID. Terminal reports retain first/final failure, attempt count, decision and execution risk. Raw prompts, JSONL records, tool output, subprocess stderr and exception causes are not serialized.
- SDK event text is classified only through tested, anchored patterns. A plain exit code 1 is not a transient error. Rejected JSONL and subprocess stderr are never searched for retry directives. Unknown formats remain unknown.
- Stream-level `error` notifications and warning/error items can describe an intermediate reconnect or transport fallback. The bridge retains the first pending notification and keeps draining the same execution. A drained `turn.completed` clears it only when the configured output selector produces a nonempty reply; a silent completion follows the ordinary failure and reconciliation path. `turn.failed`, process/parse errors, cancellation and deadlines still fail. EOF without `turn.completed` fails even when partial text exists. Unexpected errors after completion also fail. This does not start an adapter retry or change replay eligibility. A zero-character relay log does not prove zero model text or tool activity, because reply selection waits for the agent stream to finish successfully.
- A single recovery scheduler bounds attempts, cancellable equal-jitter backoff (half-to-full exponential delay) and elapsed time. The delay helper can honor a trusted Retry-After floor, but this is defensive support: no current SDK recovery producer supplies it. Octo REST Retry-After is diagnostic-only and does not schedule model retries. Current SDK versions do not expose provider headers: the adapter does not invent them or claim it can count CLI-internal network retries.
- New retries default off. With retries on, only a positively established pre-execution temporary failure is eligible in the current runtime (e.g. EAGAIN/EMFILE/ENFILE from OS spawn). A missing thread ID, missing tool event, read-only filesystem sandbox or same-thread continuation does not establish safe execution. SDK HTTP-shaped errors improve diagnostics but cannot establish that tools did not execute.
- Consequently old automatic stream continuation and stale-thread fresh replay are intentionally disabled for uncertain runs, even when new retries are off. Existing thread mappings are retained for operator reconciliation rather than silently cleared. Unused stale-replay callbacks and their per-turn fallback prompt assembly have been removed. This is a safety behavior change, not a claim of complete legacy retry compatibility.
- Timeout revokes publication and propagates AbortSignal to the SDK, relay and network sends. The gateway independently confirms owned POSIX group teardown; the proxy transports I/O and cannot attest closure. After handler settlement and teardown proof, the session admits new user requests while preserving a failed-task snapshot; external/detached effects may still require checking. See [the #39 continuity policy](session-continuity.md).
- Timed-out sessions whose managed teardown remains unconfirmed reject new model work; authenticated transport gates and the owner reconciliation command still run. Active turns left by a process crash become quarantined only after the new gateway acquires its singleton lock. TTL, /reset and restart cannot clear execution uncertainty. Normal completion revokes late callback publication as well.
- Shutdown tracks real handlers, cancels active turns and records quarantine for unknown/observed execution before closing the store. Positively unstarted turns remain clean on timeout or shutdown. A timed-out handler's late publication cannot affect a new turn. Cleanup may release only its exact execution generation after managed teardown proof, preserving interruption metadata.

## Configuration

```json
{
  "sdk": {
    "recovery": {
      "enabled": false,
      "maxAttempts": 3,
      "maxElapsedMs": 60000,
      "baseDelayMs": 1000,
      "maxDelayMs": 10000
    }
  }
}
```

Settings take effect at bot startup. Attempts include the original execution and are shared across adapter retries. Numeric settings must be positive integers; maxAttempts <= 5, maxElapsedMs <= 300000, delay values <= 60000 and baseDelayMs <= maxDelayMs. Unknown options are rejected. Recovery elapsed time starts at the first failure; the dispatch deadline is never extended. CLI/SDK internal retries consume that dispatch time, and the adapter does not assume a single network attempt per process.

The unrestricted shell/MCP runtime offers no enforceable read-only capability proof. Enabling recovery therefore does **not** enable automatic replay of arbitrary 429/5xx, stream or parse failures. Extending eligibility requires a real tool permission boundary or a business-specific external-result reconciler; there is deliberately no user-configurable “trust that tools did not run” bypass.

## Delivery and storage

The main-branch output-selection policy (#15/#30) and capped delivery/history text are preserved. Output is selected once, stored in `turn_outputs` before sending and split into fixed payloads/local correlation UUIDs persisted atomically in `delivery_parts`. These request IDs do not establish bot-endpoint idempotency: the server may ignore/replace `client_msg_no`. They must never justify an automatic resend. Credentials are excluded from stored delivery payloads. Normal message contents use the existing protected SQLite directory and seven-day retention. Generated output and delivery-part evidence belonging to the current active/quarantined turn are exempt from that automatic sweep; after release they become eligible for normal expiry. Explicit /reset still deletes outbox contents along with session history, and is not an execution reconciliation. Execution tombstones contain no message contents. Active/quarantined evidence survives automatic retention; sufficiently old clean tombstones can expire. Startup logs include the paused-session count.

Every attempted part is first marked unknown. A canonical positive decimal message ID (1–19 ASCII digits, no leading zeros or whitespace, within signed-int64 range) returned by the awaited send HTTP request confirms server acceptance. The returned client key may differ from the submitted local correlation ID and does not invalidate that acknowledgement. Server acceptance is not proof of client receipt/read status. A send exception, empty response, malformed ID or cancellation after submission cannot count as delivered. Later parts stop at uncertainty. Confirmed completion commits assistant history idempotently by turn ID; failures at delivery or history commit never invoke the model again.

This implementation keeps generated/partially delivered output for inspection. It does not automatically resend unknown outcomes: there is no established server-side deduplication contract for these local IDs. A local live probe verified a valid message ID with a rewritten client key and successful delivery/history commit; it did not establish idempotent resend semantics. It does not claim an atomic transaction between Octo and SQLite or exactly-once delivery. A process crash around an external acknowledgment still requires reconciliation. Original pending outputs are not silently treated as delivered conversation history.

Inspect only safe columns during incident response, for example:

```sql
SELECT session_key, turn_id, generation, state, updated_at FROM turn_execution;
SELECT turn_id, state, created_at FROM turn_outputs;
SELECT turn_id, part_index, state, message_id FROM delivery_parts;
```

Do not copy message content, signed URLs or credentials into diagnostic logs.

## Maintenance when managed teardown cannot be confirmed

The normal stopped-execution path requires no owner command. For legacy/crash records or missing teardown proof, first confirm that the task's managed execution has stopped and check any external effects. Cancellation, promise settlement, missing tool events, reset and restart are not external-effect verification.

After checking external effects, the registered Octo owner can recover a session in-process. In the affected conversation:

```text
/reconcile TURN_ID --external-results-verified
```

For a third-party DM or a group the owner cannot join, send this from the owner's own DM with the bot:

```text
/reconcile TURN_ID --session SESSION_KEY --external-results-verified
```

A non-owner pause notice includes the session key and turn ID to give to the owner. Explicit targets are allowed only from an authenticated owner DM; omitting the target always refers to the current conversation. The session and turn ID must both match. Active rows and retained live local handlers are refused with distinct explanations. Whitespace between arguments is flexible; session keys are exact, whitespace-free transport identifiers.

Privileged authorization requires exact equality with the validated registration owner_uid. The current server assigns both owner_uid and owner_channel_id from robot.CreatorUID: owner_channel_id is not a compound DM channel and supplies no trusted namespace. The synthetic alias-binding branch is removed. A registration UID that itself contains a prefix works by exact equality; a differently rewritten wire UID does not.

If transport rewrites the owner's UID, online reconciliation is unavailable with this API. Startup warns about this limit; pause/refusal notices direct users to the offline operator procedure below. That procedure requires gateway downtime. No incoming suffix is treated as proof of identity, and no server identity mapping is invented. Prompt is_owner remains legacy advisory attribution rather than control authorization; that deliberate distinction is documented in sender-context.ts.

The command passes transport, mention and sender/session rate limits before quarantine. Persisted quarantined traffic has a separate aggregate bucket (10 × maxPerMinute capacity/refill) plus normal sender/session limits. It cannot consume healthy model admission or admit unlimited distinct senders. Active rows use the normal global budget. Unauthenticated commands on healthy sessions receive no reply and are excluded from model context. Each recognized release/refusal is audited with actor/session SHA-256 hashes, a validated task ID when available, and a closed outcome. Raw identities, session keys and command text are withheld. Exact target/turn is checked before revealing active/handler state. The command runs inside the source session queue; the target live-handler/state checks and exact SQLite update run synchronously without nested cross-session locks. It does not create a new model turn. It verifies the exact session/turn pair and rejects a retained local handler; database state is authoritative so an offline release cannot be shadowed by an old memory cache. Group commands must mention the bot unless server policy permits no-mention replies. This acknowledgement releases admission for new messages only: it does not replay, resend, mark old output delivered, or reconcile external systems itself.

The offline helper remains available for operator maintenance. Stop the gateway first and use the matching identifiers:

```sh
node dist/reconcile-turn.js /absolute/path/to/data/cc-octo.db SESSION_KEY TURN_ID --external-results-verified
```

It uses the gateway's O_EXCL lock, refuses any existing lock and changes only the exact quarantined row. Restart after offline maintenance. Never remove a live lock to bypass the check. Neither path clears conversation history.

## Verification requirements and limits

Automated coverage includes classification/privacy, positive spawn retries, first/final failure, bounded attempts, jitter/Retry-After budgets, abort during backoff, missing-thread and post-tool failures, durable timeout/restart quarantine, late callback revocation, shutdown, outbox uncertainty, malformed acknowledgments and server-rewritten client keys and idempotent history commit. The existing real-SDK Unicode/JSONL/termination tests cover the proxy lifecycle, including a backpressured proxy with an uncooperative direct child. None establishes that arbitrary detached/remote effects stop on abort.

Changed legacy recovery tests explicitly test no replay/mapping reset under uncertainty. Successful sender framing and output selection still have byte/behavior checks. No production credentials are used in tests. Live provider availability, externally enforced read-only execution and remote-effect reconciliation remain separate acceptance work. Server-side idempotency would require an explicit API contract before any future resend feature. Issue #27 tracks attachment sending and is not implemented by this PR.

## Author review

The self-review checked three cross-cutting boundaries: (1) no replay without positive pre-exec evidence, (2) no late publication after success, cancellation or generation replacement, and (3) no delivery failure causing model replay or falsely committed history. Findings fixed during review included revoking successful-turn callbacks, moving crash quarantine recovery behind singleton ownership, recording unknown delivery before network submission, atomic persistence of all fixed delivery parts, and allowing shutdown to settle the dispatch gate even when dispatch timeouts are disabled.

A negative control deliberately removed the execution-risk guard from retry eligibility: two regression tests failed; restoring the guard passed. Existing behavior tests were migrated where they required unsafe stream/stale replay; normal output selection and sender framing remain covered. The offline helper is tested for explicit acknowledgment, wrong turn IDs, existing gateway locks and nonexistent databases. These are local checks, not independent approval or live provider acceptance.

## API diagnostics

REST errors carry a closed endpoint template, HTTP status (when available), stage,
and failure detail (`http_status`, `network`, `response_read`, `invalid_json`).
Only sendMessage uses the delivery stage; registration, heartbeat, typing,
history and other preparation requests use prepare. Query strings, group/thread
identifiers, server error bodies, statusText and raw causes are withheld for POST,
GET and upload-credential requests alike. No secret-bearing body is retained as
"sanitized" evidence. Endpoint/status remain visible to startup operators.

The dispatch timeout default remains 300 seconds. Choose a longer value for
long-running workflows; increasing it does not make uncertain execution replay
safe. Timeout before SDK execution stays clean; unknown/observed execution pauses
until the registered owner explicitly reconciles it.

The query API intentionally removes obsolete `onResumeFailed` / `fallbackRetryPrompt`
options and the unused `isStreamInterruptError` export, rather than accepting
callbacks that cannot run. `AgentOutputEvent.reason` is narrowed to `initial` and
`request_retry`. Current producers always emit `continues: null`; the collector
keeps legacy lineage handling defensively, not as an enabled recovery mechanism.

## Current review follow-up

Review #5521938058 and addendum #6174915906 are addressed using the explicitly
fail-closed maintenance option: exact registered identity online, truthful
startup/pause warnings and offline maintenance for rewritten owner UIDs. The
actual register source sets owner_channel_id == owner_uid; synthetic compound
register fixtures are not used to claim alias support.

Paused group chatter remains in the bounded context cache. Control, oversized,
rate-limited and shutdown-rejected traffic remains excluded. Real handler tests
use the SQLite ledger and assert durable quarantine after inference failure,
clean state after preparation failure, and refusal to invoke the model again.
Conversation document warnings read structured HTTP status; reset uses the
turn-guarded store. API request timeouts remain 30 seconds. Timeout wording
checks the deadline, including synchronous deadline observation before a timer.
Generation numbers are diagnostic; actual fencing uses revoked publication and
an exact current turn_id predicate.

CI now runs npm run type-check:recovery-tests for recovery/API and bridge/selection
contract tests, alongside production types. Historical tests outside this strict
subset remain runtime-tested; the change does not claim otherwise.

Current follow-up validation: SDK 0.142.3 and 0.162.1 each pass 76 files / 1609
serial tests. Production types, the CI recovery-test type target, lint, build
and package checks pass. Four negative controls are rejected: disabling the
production quarantine predicate, dropping paused chatter, reverting structured
HTTP status to message parsing, and removing the paused aggregate cap. The
register implementation was directly inspected: both API paths assign OwnerUID
and OwnerChannelID from robot.CreatorUID. This is source verification, not a
live transport fault-injection or remote-effect termination guarantee.

### Canonical acknowledgement follow-up

The inherited lossless-ID rewrite can recover illegal leading-zero numeric tokens as strings. Those recovered values must not gain confirmation authority: the relay now requires canonical positive decimal IDs, bounds their length before BigInt conversion, and enforces the signed-int64 maximum. This does not replace the REST parser with a strict lossless parser or establish evidence that a malformed server response delivered a message.

Seventeen new regressions drive real handler/router/relay/REST parsing and SQLite state with synthetic fetch/model events. They cover both reported malformed raw numeric tokens, noncanonical strings, zero/over-range identities, and lossless valid boundaries through int64 max. Rejected acknowledgements leave parts unknown and output generated, cannot commit response history or advance the reply cursor, and never rerun the model. Four expectations fail on the preceding validator. Both SDK 0.142.3 and 0.162.1 passed 77 files / 1626 tests; production and focused test types, lint, build and package checks passed. No live malformed-response incident or deployment is claimed.

### Main integration after #30

Merged main `4ca3d72` while retaining `af1b7d8` recovery and acknowledgement fixes. Conflict resolution preserves both packaged guides, per-bot recovery validation and main's strict `final` default. The retry scheduler, quarantine/store/relay logic and canonical acknowledgement validator are unchanged. SDK 0.142.3 and 0.162.1 each passed 78 files / 1670 full serial tests, production/focused test types, lint and build. Package checks include both guides, the executable proxy and reconciliation helper. No production deployment was performed.

### Deferred notification outcomes

A `turn.completed` event alone does not discard a deferred error. After the SDK stream drains, the bridge applies the same output-selection mode and response cap as delivery. If the selected reply is empty, the first deferred failure is thrown before any successful `attempt_end`. The handler retains its diagnostic and records execution uncertainty; after owned teardown, the next user-authored turn receives the interrupted-task verification guard. No previous task is automatically replayed. A later explicit `turn.failed` or SDK/process exception still takes precedence.

Successful recovery emits a fixed deferred marker and a fixed recovered marker with a notification count capped at 65535. The deferred marker is emitted only once per attempt. These logs contain no SDK error text, output, identifiers or prompt content. Notifications on a successful answered turn do not create a failure row. This is observability only, not retry or execution evidence.
