# DEV-01 evidence snapshot and rerun guide

## Provenance (read first)

Every record in this directory was produced locally from the pinned parent
`dd1298083d014d8e82376c01edb38a2e6914366f` **plus the uncommitted DEV-01 working
tree**, and is labelled `dd1298083d01…+dirty`. It is a historical snapshot, not
verified-head evidence. Acceptance still requires re-running everything on the
clean fork commit and on remote CI; no result here may be carried forward to a
later head (R8 §10.8).

Host: macOS arm64, Node v26.5.0 (unless stated). Pins: A `dd12980`, B
`2e710e9`, OC `f6065d6` (OC `main` has drifted to `df8c7dd`; the pin is kept),
codex `0.142.3` (installed SDK vendor binary), croner `10.0.1`.

## Rerun guide

Current-run outputs go to the git-ignored `artifacts/` tree by default
(`DEV01_REPORT_DIR`, `DEV01_EVIDENCE_DIR`, `DEV01_MUTATION_DIR` override it);
committed files under `test/evidence/dev01/` are never rewritten by default.
Runner provenance (`head`) is captured before execution and excludes generated
snapshots under `test/evidence/` and outputs under `artifacts/`. Executable
evidence tooling remains source; any source, test, fixture or config change
yields `<sha>+dirty`.

| Command | What it checks |
|---|---|
| `npm ci && npm test` | full default suite (baseline 55 files / 1178 tests + DEV-01 suites) |
| `npm run test:unit-records` | same, with R8 §10.1 JSON + JUnit records |
| `npm run test:real-binary` | SB-01..14, SP-T1, SB-FIX against codex 0.142.3 + loopback mock Responses |
| `npm run test:parity-matrix` | fresh full unit run, then structural inventory and every `passed` claim against that fresh JUnit (reports each status separately) |
| `npm run test:manifest` | manifest linter + ORACLE-01..08 |
| `npm run test:egress` | egress bypass scan (repo + negative fixtures) |
| `npm run test:downgrade` | dd12980 build reopens a populated DB |
| `npm run test:goldens` / `npm run goldens:verify` | golden provenance / byte reproduction from pinned B (`../openclaw-channel-octo`) and OC (`../openclaw`) checkouts |
| `npm run test:mutation` | 12 mutation negative controls for the locks |
| `npm run pack:smoke` | tarball contents, native load, installed CLI |
| `npm run check:src-scope` | src changes limited to `src/seams/{clock,fault-plan}.ts` |
| `npm run type-check && npm run type-check:test && npm run lint` | src and test typing, lint |

## Results in this snapshot

| Evidence | Result |
|---|---|
| `runs/unit.{vitest.log,results.json,junit.xml}` | 88 files / 1628 tests: 1369 passed, 258 todo (named pending contracts), **1 failed = PM-05** (blocker 1). Baseline 1178 tests all pass; `src/__tests__` unchanged vs dd12980 |
| `runs/unit-node22.vitest.log`, `runs/unit-node24.vitest.log` | Node 22.23.3 / 24.21.0 isolated `npm ci`: 86 files / 1616 tests, only PM-05 failed. Taken before the later CI/source-state/SP-T1-classifier tests were added; not rerun on 22/24 since |
| `runs/real-binary.{vitest.log,results.json,junit.xml}`, `real-binary/<case>/` | 19 passed, 2 todo (DEV-04 runtime parts of SB-02/SB-04), **1 failed = SB-07** (blocker 2). SP-T1 outcome **A** (`real-binary/SP-T1/sp-t1-outcome.json`; the pinned schema exposes no non-`thread/start` dynamicTools registration path). Raw JSONL transcripts, stderr, mock request logs and rollouts are kept per case (fake key redacted) |
| `sb07-stability/orders.txt` | SB-07 observed order identical in 3 extra runs |
| `runs/parity-gate/` | fresh full run: unit exit 1 (PM-05 only); structural inventory 0 issues; 86 `passed` claims all confirmed in the fresh JUnit (1628 cases) |
| `runs/parity-matrix-validate.json` | 355 rows: 86 implemented/passed, 42 partial, 213 pending, 14 approved exclusions; 0 issues |
| `mutation/` | 12/12 mutants killed by executed assertions; unmutated controls pass |
| `red/` | infrastructural RED: 17 new files failed at module load on the pinned tree (no assertion executed) |
| `red-executed/` | executed-assertion RED: CI-01/02/03/04/08 and PM-05 fail on dd12980 config; CI-05 failure there was environmental (no `.git`) |
| `negative-controls/ci-09-merge-ref.txt` | CI-09 fails when a candidate checkout uses `refs/pull/N/merge` |
| `runs/goldens-verify.log` | B and OC goldens reproduce byte-for-byte |
| `runs/pack-smoke-node{22,24,26}.*` | all checks pass; Node 22/24 records predate the pack-smoke provenance change, Node 26 rerun after it |
| `real-binary-run1/` | first real-binary run: harness network escape (see findings) |
| `real-binary-network-findings/` | plugin git-sync escape caught by the loopback guard |

## Open blockers (not passed)

1. **R8-MGMT-27 / PM-05** — R8 §4 O24 / §9 DEV-14 require 27 `octo_management`
   actions. Pinned B `src/agent-tools.ts` (sha256 `bf549838…cbf06`) has 24; `send`,
   `read`, `search` are separate message-tool actions (`src/channel.ts`). The golden
   and matrix record the source as-is (24 + 3). PM-05 stays failing until a
   source-backed R8 amendment.
2. **SB-07 order contradiction** — R8 §6.3 expects item `failed` →
   `turn/completed` → `serverRequest/resolved`. The pinned binary emits
   `serverRequest/resolved` immediately after the parity reply, before
   `item/completed:failed` and `turn/completed:completed` (stable across 5 runs;
   request id 0, parity error reply and statuses otherwise as R8 states). The
   expectation is unchanged; needs an R8 amendment or a different reading.

## Findings for later stages

* The binary contacts external endpoints unless redirected: Responses websocket
  (`openai_base_url`), ChatGPT backend `plugins/featured` (`chatgpt_base_url`) and a
  curated-plugin `git ls-remote https://github.com/openai/plugins.git`. The harness
  routes the first two to the loopback mock, disables `features.plugins` and sets
  `GIT_ALLOW_PROTOCOL=file`, and fails any case whose output references a
  non-loopback host. Run 1 reached `wss://api.openai.com` with the fake key (401)
  because a root-level `-c` override is dropped when `exec` gets its own `-c`;
  earlier runs may have performed the public plugin git sync without logging it.
  DEV-03/04 must decide the production configuration for these paths.
* `src/__tests__/config-watcher.test.ts` (unchanged baseline test, 2 s fs.watch
  window) failed once in 4 full local runs under load; 5/5 in isolation.
* `pack-smoke` installs `@openai/codex-sdk ^0.142.0` from the registry; exact
  pinning is DEV-04 scope.
* Remote CI has not run; the workflow is validated only by `test/ci` assertions.
