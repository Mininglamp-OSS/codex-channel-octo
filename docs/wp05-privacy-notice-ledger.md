# WP-05 privacy notice assertion ledger

Authority: OQ-02 Ledger v1, XIN-2056 comment
`e3b2d472-619f-4a62-a17e-36af2fb4ed1d`, Owner A1–A6 approval
XIN-2038 comment `efe5c8ef-3e3d-4044-ae28-84d26482729e`, and Baseline v18
comment `d2175d40-35e9-4afa-bd87-576a0f142d57`.
Direct implementation parent: `eb516523659d8b824dfafa0ac1274f535fcb7925`.

| Approval / row | Parent ordinary notice | WP-05 ordinary notice | Exact assertion evidence |
| --- | --- | --- | --- |
| A1 / PN-01–02 | `🔧 Running command(<program or first token>)…` | `🔧 Running command…` | `cards-notices.test.ts`, six-label assertion; `cards-safe-bridge.test.ts`, legacy and safe callback comparison |
| A1 / PN-03 | `🔧 Running file_change(<basenames>)…` | `🔧 Editing files…` | Same exact label assertion; corpus POSIX/home/relative/Windows count-only fixtures |
| A1 / PN-04 | `🔧 Running mcp_tool_call(<server>.<tool>)…` | `🔧 Tool…` | Same assertion; corpus identifier/argument/result omission |
| A1 / PN-05 | `🔧 Running web_search(<query>)…` | `🔧 Searching…` | Same assertion; corpus query/URL omission |
| A1 / PN-06 | `🔧 Running reasoning…` | `🔧 Thinking…` | Same assertion; no text leaves reducer |
| A1 / PN-06 | `🔧 Running todo_list…` | `🔧 Planning…` | Same assertion; no task text leaves reducer |
| A1 / PN-07 | arbitrary formatted callback detail | typed reduced facts, fixed labels | Channel supplies no legacy callback; original `formatToolParams` source/export/tests preserved |
| A2 / PN-08 | consecutive equality includes raw detail | equality uses fixed rendered category | `A,A,B,A → A,B,A`; different programs collapse; ten attempts including rejected sends; no count reset in callback |
| A2 / PN-09 | off has no notice | off has no safe callback and no notice | Original e2e off assertion retained; additive explicit absent-sink assertion |
| A3 / PN-11–15 | no automatic card lifecycle | no lifecycle or optional fallback introduced | Later-package scope; ordinary timeout/error/empty assertions remain unchanged |
| A4 / PN-19–20 | no authored card traversal | unchanged | Later-package scope; no builders added |
| A5 / PN-21–24 | no card result/admission contract | unchanged | Later-package scope; no tools/admission added |
| A6 / PN-27 item 1 | fake `Bash,Bash,Read` stimulus; exact `Running Bash`, `Running Read` notices | typed command/repeat/file-count stimulus; exact `Running command`, `Editing files` notices | Only original assertion migration, in `e2e.test.ts`; final `done` assertion retained, history/privacy negatives added |
| A6 / PN-18 and PN-27 items 2–3 | relay return and successful-send setup | unchanged | WP-07 scope; no DeliveryReport changes or setup migration |

No other original assertion or snapshot changes. `summarizeItem` source and
export, the entire original summary and callback test file, canonical event
tests, and all `formatToolParams` assertions remain byte-identical. Other
protected source remains identical except the narrow safe-notice callback
wiring in the bridge and ordinary channel integration. Selection, final
answer/history, prompts, documents, sessions, recovery, mentions, splitting,
attachments, routes, configuration, card contracts and unrelated logging
remain unchanged. Only the safe notice failure log becomes a fixed message;
its exception body is omitted, and a throwing safe callback logs a fixed message.

## Reducer choices

The pinned program allowlist is `git,npm,node,python,python3,ls,cat,grep,rg,sed,find,make,pytest,tsc`.
Ambiguous or unknown programs become `command`. A bounded forward scan validates
complete command words, including argv syntax, without executing or expanding
shell text. Leading assignment values may contain balanced literal quotes;
quoted programs, unmatched quotes, expansion, separators, ambiguous escapes,
non-ASCII whitespace and obscuring controls fail closed. Horizontal tabs remain
explicit separators. No argument value leaves reduction. Files are bounded to 10,000
well-formed entries and expose count only. Domains use HTTP/HTTPS and the
pinned ICANN+PRIVATE PSL; IPs, local/reserved/unknown suffixes, malformed URLs
and suffix-only hosts become `link`. IDNs produce canonical ASCII/punycode.
Userinfo, subdomains, paths, queries and fragments never leave URL reduction.
No domain is truncated into a different hostname. Missing or altered PSL
bytes disable domain extraction without exposing file paths.

Exit facts are `ok|nonzero|unknown`, with successful/nonzero classification
only on completed commands. Failed status exposes `failed`, never an error
body. Optional duration buckets are `short` (<1,000 ms), `medium` (<60,000 ms),
`long`, or `unknown` for malformed values. No clock or timing inference occurs.
Reasoning and todo carry activity flags only. MCP identity is always omitted;
trusted injected identity handling remains later-package scope.

Every output string is scanned and normalized; the explicit default caps are
192 Unicode scalars and 768 UTF-8 bytes. Controls, format/bidi characters and
unpaired surrogates are stripped; remaining text is NFC. Secret scans also
use NFKC to detect compatibility-obscured shapes, scan before truncation, and
replace detected values with fixed generic values. All pinned vendor prefixes
are matched case-insensitively, including after URL/IDN hostname case folding;
this applies to the final scan of every emitted string. Hex runs of at least 24
characters require entropy ≥3 bits/character; base64-like runs of at least 32
require ≥3.5. False positives deliberately reduce detail. This is a bounded
shape detector, not a guarantee against every possible encoding.

Domain facts additionally scan bounded raw hostnames, canonical UTS-46 ASCII
and decoded Unicode, with an exact ASCII round trip. Joining-aware vendor
checks operate within plain/Unicode labels without a word-boundary assumption;
encoded A-label payload adjacency is evaluated through its decoded U-label.
Empty/oversize/invalid representations fail closed. Only hostname facts are
decoded; credentials, paths, queries and fragments are discarded before this
oracle. Every emitted domain still passes the final output scan. Corpus v3
binds exact ASCII/Unicode conversions for Unicode and already-punycode inputs,
ICANN/PRIVATE/subdomain cases, NFC/NFD, mixed/fullwidth and ASCII joining,
with benign IDN controls and a killed decoded-Unicode removal mutation.

The safe sink is a separate optional sixth callback parameter on both bridge
entry points. The original `QueryAgentOptions` fields and all five original
parameters retain their exact types and behavior.

The versioned synthetic corpus covers paths, environment/argv, files, queries,
MCP fields, outputs/errors, prompt/memory markers, credentials/DSN/JWT/vendor
prefixes, URL components, ICANN/PRIVATE/wildcard/exception rules, IDN, IPs,
Unicode controls/normalization and scalar/byte/entropy boundaries. Corpus v2 adds all 17 pinned vendor-prefix alternatives across original/lower/
upper/mixed case, subdomains, PRIVATE suffixes, IDN/fullwidth boundaries and
benign domains. Its command cases cover short adversarial inputs and the 8,192
input limit. A child-process deadline interrupts stalled parsing; negative
controls exercise the rejected lexer and case-sensitive detector, with timing
receipts at 64/1,024/4,096/8,192 characters. Tests add
malformed/prototype/accessor/symbol/proxy inputs, deterministic immutable
outputs, callback cadence and exact-route notice integration.

Local reducer/notice evidence does not establish future card sends/edits,
telemetry, live privacy scans or deployment acceptance. The historical
sdk-jsonl timeout and XIN-2153/W-01 remain unresolved; their tests, timeouts
and configuration are untouched.
