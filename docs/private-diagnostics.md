# Private operator failure diagnostics

Closes #36. This is separate from execution recovery: enabling it never changes quarantine, owner reconciliation, retries, model invocation, or delivery confirmation.

## Enable and locate

`privateDiagnostics` is a validated boolean under `sdk`, inherited from global defaults and overridable per bot. It is off when absent or false. Set it to true and restart/re-add the bot. Local records are at `<bot>/data/diagnostics/agent-failures.jsonl`, with `.1` and `.2` rotations. The directory is mode 0700 and files are mode 0600. Files and the diagnostics directory must be regular/non-symlink paths; unsafe paths, oversized pre-existing files, and I/O errors fail closed without changing task handling.

## Recorded fields and privacy

Records carry a generated diagnostic ID, timestamp, closed first/final stage/category/source/evidence snapshots, bounded status/retry metadata, attempts, execution risk/decision, Node version, and optional SDK event provenance. Arbitrary SDK text is never persisted: its bounded prefix is SHA-256 fingerprinted, with byte length and a truncation marker. This lets an operator group recurring unknown failures without storing a prompt, token, URL, provider payload, stack, exception cause, raw JSONL or tool stdout/stderr. System error codes are drawn from Node's OS-code allowlist. Public errors and Octo replies do not contain the private context.

A fingerprint cannot reconstruct the original error or prove its cause. `unknown` remains unknown; matching fingerprints are correlation hints, not safe-retry evidence. The facility intentionally does not reproduce the unrestricted raw-error logger used in local incident debugging. Add new recognized error patterns through reviewed, tested classification changes instead of turning raw payload capture on.

## Bounds and failures

Records are capped at 16 KiB. The active file is rotated before a record would exceed 1 MiB; at most the active file and two previous files remain (3 MiB total). This is size retention, not a time guarantee. Changing the feature to false stops writes and leaves existing records intact. Diagnostic failures emit only a fixed warning; they do not replace the original error, rerun a task, or fail the bot. Each bot has a separate data directory.

No production credentials or backend fault injection are used in the regression tests. Real loopback transport/process tests validate the existing harness, not a live provider's error taxonomy.

## Separately opt-in SDK detail

Set **both** `sdk.privateDiagnostics: true` and `sdk.privateDiagnosticsDetails: true` to add `sdk.detail` to failure records. Both settings inherit global defaults and allow per-bot overrides. Details alone do not enable capture or writes. Turning either setting off stops detailed capture for subsequent runs; turning off `privateDiagnostics` stops all writes. Existing records remain until size rotation or manual removal. No raw-text mode is provided.

With only `privateDiagnostics` enabled, the existing hash-only schema and fingerprint algorithm remain unchanged. All modes now reject symlink ancestors, hard-linked files and pre-existing files with group/other permissions. The existing data directory must exist. Unsafe destinations fail closed, including rotated paths, and the application retains the original failure. Keep the data directory private and exclusively managed by the gateway.

Detailed fields use a closed vocabulary and scalar bounds:

- Own data properties only: `code` must be a known Node OS code or one of `context_length_exceeded`, `invalid_encrypted_content`, `rate_limit_exceeded`, `insufficient_quota`, `server_error`, `invalid_api_key`, `model_not_found`. Proxy inputs are rejected before reflection, including exception and event correlation inputs, so diagnostic descriptor traps cannot mutate failures. No coercion, inherited properties, getter invocation, payload traversal or SDK serialization occurs.
- The first valid own numeric `status`, `statusCode` or `httpStatus` is accepted only as an integer 100–599; numeric `exitCode` only as an integer 0–255; `signal` only as a known OS signal name. Exit fields carry `exitSource: own_field`. These are field-derived observations, not proof of authenticity or execution state.
- SDK 0.142 sometimes supplies process metadata only inside an exception message. A bounded, anchored `Codex Exec exited with code …:` or `… signal …:` header yields only its numeric/allowlisted value with `exitSource: sdk_message_template`. No stderr suffix is retained or searched for causes. Fixed `templateId` values identify a small set of recognized error/notice shapes without copying matched substrings. `noticeTemplateId` records the last already-recognized model notice in that attempt; it neither suppresses failures nor expands notice matching.
- `eventSubtype` distinguishes item started/updated/completed, turn failure, stream error and exception. `mode` is `start` or `resume`; `attempt` is zero-based and resets correlation for each execution attempt. The public `diagnosticId` correlates the failure report to its private row; it is not an SDK thread or turn ID.
- Resume input, observed `thread.started.thread_id`, and optional own `turn.started.turn_id` are separately SHA-256 fingerprinted, never copied. Empty or over-256-byte identifiers are omitted rather than truncated. The current SDK turn-start schema has no turn ID, so that fingerprint is normally absent. Missing thread/turn events do not prove that execution never started. Only the final failure's provenance is retained through recovery, not an event history. SDK construction exceptions also receive detail under the new dual opt-in; their original throw/recovery boundary is preserved. Legacy hash-only construction failures remain outside SDK capture.

Detailed rows use the same 16 KiB record, 1 MiB file and three-file bounds. Fingerprints retain the original first-8192-UTF-16-code-unit algorithm for compatibility (not a new byte-limited text excerpt); records never contain that prefix. Unknown text still supplies only a fingerprint, byte count and truncation flag. Finite templates cannot reveal every lost cause. A matching code, status, template, fingerprint or notice is never new classification or retry evidence. Public snapshots, IM replies, console reports and task handling remain unchanged.

### Privacy and filesystem limitations

This mode deliberately avoids arbitrary scrubbed excerpts: redaction cannot guarantee secrecy for arbitrary provider or attacker-controlled text. No claim of perfect arbitrary-text secrecy is made. Even metadata is sensitive: fingerprints permit equality correlation and guesses of low-entropy inputs; codes, status, lengths, timing and hashed identifiers can disclose operational patterns. Do not publish these files without a separate review. No messages, prompts, history, tool output, full JSON, URLs, credentials, stacks or causes are stored.

Directory components and rotation slots are revalidated around operations. Opened files use no-follow/nonblocking flags, inode checks, single-link checks and bounded sizes, with 0700/0600 permissions. macOS's fixed system `/tmp` and `/var` aliases are canonicalized; other symlink components are rejected. Node has no portable directory-relative `openat`/`renameat` interface: this is not isolation from a malicious process running as the same OS user that continuously swaps paths or concurrently writes files. One gateway writer per data directory is required for size/count guarantees. I/O failures may leave a partial final record or an incomplete rotation; diagnostics fail closed without replacing the task error. Retention is size-based, not time-based, and disabling capture does not erase old records.

## Arbitrary text capture is unsupported

`privateDiagnosticsText` and `sdk.text` are not supported. The temporary excerpt mode was removed because credential redaction cannot enforce the metadata-only privacy contract. Legacy configuration containing that extra key cannot enable text capture. Unknown messages retain only their fingerprint, byte count and truncation marker, even with detailed diagnostics enabled. Existing records from the temporary mode are not rewritten or erased by this change.

The private writer relies on POSIX directory descriptors, no-follow open flags and owner-only mode bits. The safeguards require POSIX filesystem semantics; native Windows support is not established. Unsupported filesystem operations fail closed rather than relaxing permission or path checks.


Reflection hardening: diagnostic exception capture accepts non-proxy native errors and reads an own data `message` descriptor or invokes the captured built-in DOMException message accessor after a native brand check. SDK/user-defined accessors are never invoked; native AbortError/TimeoutError fingerprints are retained. Provenance lookup/inheritance uses WeakMap identity without `instanceof`. Proxy detail fields omit only optional details, retaining an available hash-only context. The common classifier rejects proxy prototype chains and custom accessor-bearing failure inputs as `unknown`; only captured built-in DOMException accessors pass a native brand check, preserving structured cancellation/timeout categories, regardless of diagnostic flags, rather than invoking their traps. Missing `O_DIRECTORY`, `O_NOFOLLOW` or `O_NONBLOCK` is rejected before any filesystem mutation.
