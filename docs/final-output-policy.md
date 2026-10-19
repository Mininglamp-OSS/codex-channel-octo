# Default reply selection when exec JSONL omits phase

Tracks #29; follows up #11 and merged #15. Baseline main b381706. No dependency on unmerged #28 and no change to retry/cancellation semantics or attachment support (#27).

## Confirmed source contracts

Codex CLI rust-v0.162.1:

- [Internal MessagePhase](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/protocol/src/models.rs#L944) includes Commentary, PartialAnswer and FinalAnswer; serde uses snake_case. Provider emission is optional/inconsistent.
- [exec JSONL mapping](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L148) converts `ThreadItem::AgentMessage { text, .. }` to `AgentMessageItem { text }`, discarding other metadata.
- [Exec event schema](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/exec/src/exec_events.rs#L138) and [SDK item type](https://github.com/openai/codex/blob/rust-v0.162.1/sdk/typescript/src/items.ts#L75) have no phase field. The SDK does not reconstruct one.

OpenClaw d029874 and openclaw-channel-octo bbdb267:

- [Dispatcher](https://github.com/openclaw/openclaw/blob/d0298744306f8bc30468cf9d2726544c6a2517c0/src/auto-reply/reply/reply-dispatcher.ts#L642) assigns tool/block/final literals through program call paths, not model-generated text tags.
- [Octo adapter](https://github.com/Mininglamp-OSS/openclaw-channel-octo/blob/bbdb267fdbfcf79e540fa169b54afd0904a2cdbb/src/inbound.ts#L3559) sends final payloads, replaces its buffered block text and falls back to the last buffered block. This is not Codex's protocol phase.

The previous default phase mode therefore preserves all unknown messages in actual deployed exec streams. Casting an optional field or prompting for special text tags cannot establish a typed final-answer contract.

## Implemented policy

Add `sdk.outputSelection: "final"` and make it the runtime default when unset.

1. Use the existing eligible attempt pool: the final attempt's messages, or its explicitly linked recovery ancestors when it produced none. Never inherit from an unrelated stale attempt.
2. For this mode ignore whitespace/default-ignorable-only messages without altering the bytes of selected nonblank text.
3. If explicit final_answer messages exist, keep all of them in first-seen order with blank-line separators. Exclude commentary and partial_answer items.
4. Otherwise keep only the last useful non-commentary item by first-seen sequence, regardless of earlier message lengths. Length cannot distinguish progress from answers. Updates replace contents without changing first-seen order.
5. If the selected pool contains exclusively commentary items, keep its last useful item (`commentary_last`). A blank unknown/final/partial item in that pool prevents this fallback: filtering blanks must not newly expose labeled commentary. If nothing useful remains, return empty and preserve the existing no-response notice.
6. Log `phase` for explicitly labeled finals, `last_message` for ordinary ordering fallback, and `commentary_last` for commentary fallback. Each fallback uses a `_partial` suffix for inherited/non-terminal output; explicitly selected `partial_answer` also uses a partial source even after `turn.completed`. Selection diagnostics log no text. In `final`, dropped counts cover only useful candidates in the selected pool; excluded ancestors and blank items are not reported as lost content. A pool with no useful primary or ancestor output is reported as `primary`.
7. Apply the cap once and feed the identical selected text into delivery and history, preserving mention rendering and splitting behavior.

Existing explicit phase/heuristic/legacy modes remain unchanged, including their own fallback rules. A newly recognized partial_answer is a non-commentary item, not a final signal. No dependency is patched and no reliable metadata is invented.

## Tradeoffs and migration

This deliberately fixes the normal unlabeled-runtime path without claiming semantic certainty. The last unlabeled message may itself be progress/partial content. No length-based restoration is applied: an earlier unlabeled answer, even a long one, can be replaced by a short sign-off. This is an explicit ordering tradeoff; no threshold can reliably identify answers without transport metadata. All explicitly labeled final parts are preserved. Users who require every unlabeled part can choose explicit phase; legacy retains separator-free concatenation. A future reliable transport can supply real phase metadata without changing the selection contract.

Changing the code default affects only unset configurations after restart. Explicit phase remains phase: changing config is an operator action, not performed by this PR. Existing bot instances must restart to pick up either code or config changes. toolProgress is independent and unchanged.

## Review and validation

Review invariants: no dependence on unavailable metadata, no text-pattern final classification, no reordering by snapshot arrival, no accidental cross-attempt inheritance, no dropped labeled multipart final, no divergence of delivery/history, and no claim that a partial fallback completed the task.

New regression tests first produced eight failures on the old implementation. Coverage includes unlabeled messages with/without tools, multiple trailing messages, snapshots, blank tails, explicit multipart finals, partial_answer, commentary-only fallback, recovery lineage, no-terminal attempts, unrelated fresh attempts, caps, compatibility modes and the actual SDK-event-to-bridge-to-selector boundary. Pipeline tests exercise default delivery/history parity with unknown phases. These are local/synthetic tests, not a live-provider phase guarantee or a labeled-corpus quality evaluation.

Initial validation before review: SDK 0.142.3 and 0.162.1 each passed 72 files / 1534 tests, plus type-check, zero-warning lint, build and package checks. The package includes this document and the executable JSONL proxy.

## Earlier RC follow-up (length guard superseded below)

The follow-up covers U+200B/U+2060 and other default-ignorable-only tails without
stripping embedded joiners or changing meaningful text. It tests the guard's
short-sign-off benefit and long-progress tradeoff, blank non-commentary plus
labeled commentary, partial metadata, accurate pool/drop diagnostics, missing
`item.started.text` through the real bridge, and mention offsets under the
shipped default. Compatibility selection-table tests now state `phase` explicitly;
the helper itself defaults to `DEFAULT_OUTPUT_SELECTION_MODE`. Missing/non-string
message text is normalized defensively; this is a crash fix for every mode, not
a new output eligibility policy for valid compatibility-mode input.

Follow-up validation: SDK 0.142.3 and 0.162.1 each passed 72 files / 1559 tests;
type-check, zero-warning lint, build and packing passed. Restoring the pre-review
selector caused 22 failures in the new regression suite. A seeded 6000-stream
comparison across `phase`, `heuristic` and `legacy` (18000 complete result
comparisons, including snapshots, formatting tails, lineage, caps and terminal
states) found zero differences for valid string-message inputs. No live-provider
frequency claim or deployment is made by this follow-up.

## Strict final fallback correction

Local delivery diagnostics showed `substantive_guard` retaining six messages (19184 characters) in one attempt. The guard introduced in the earlier follow-up incorrectly restored long unknown progress before a short answer. Final mode now unconditionally selects its last useful non-commentary item when explicit finals are absent; heuristic mode retains its independent guard. This changes the earlier short-sign-off tradeoff deliberately and removes the final-mode guard diagnostic sources. No retry, cancellation, or diagnostics policy is changed.

Correction validation: the new final-selection expectations failed six assertions against the prior implementation before the selector was changed. SDK 0.162.1 full serial suite: 72 files / 1561 tests; type-check, zero-warning lint, build and actual npm pack passed. A seeded 6000-result comparison against the preceding selector found no differences in explicit phase/heuristic/legacy modes.

Local combination validation used #28 d39aa3a, #37 3b683f0c and this correction on #30. After resolving merge conflicts, the integration-only diagnostics category table also needed `api_failed` from the newer #28 (not a #30 change). That combined tree passed type-check, recovery-test type-check, lint, build and 79 files / 1685 tests under SDK 0.162.1. This is a resolved integration result, not a claim that the independent #37 branch already includes that compatibility adjustment. No production configuration or deployment changed.

SDK 0.142.3 also passed the full serial suite (72 files / 1561 tests), production type-check, lint and build for this correction.
