# DEV-01 test harness

This source-checkout harness checks transport, delivery evidence, compatibility and future feature contracts. It does not implement the planned App Server runtime, scheduler or management tools. The only production additions are the dormant Clock/FaultPlan interfaces under `src/seams/`; the default gateway behavior comes from main.

## Install and run

Use Node 22+ and `npm ci`. The gateway retains main's `@openai/codex-sdk: latest` policy and its committed lock. A separate **development-only** alias, `codex-contract-cli`, installs CLI 0.142.3 for historical protocol tests. It never replaces the gateway's paired CLI or the global executable.

```sh
npm run type-check
npm run type-check:test
npm run type-check:mention-tests
npm run type-check:recovery-tests
npm run type-check:continuity-tests
npm run lint
npm run build
npm test -- --maxWorkers=1 --no-file-parallelism
npm run test:egress
npm run test:manifest
npm run test:downgrade
npm run test:mutation
npm run pack:smoke
npm run test:real-binary
npm run test:parity-matrix
```

The real-binary suite uses a loopback mock Responses service, a fresh temporary HOME/CODEX_HOME and fake credentials. Linux CI runs it in a network namespace with only loopback enabled after installing the sandbox prerequisites. On other hosts, endpoint overrides and log checks are defense in depth, not a network firewall. It is not a live provider or Octo backend acceptance test. Two explicitly named runtime contracts remain pending future implementation.

## Test inputs versus generated results

Keep test code, small protocol fixtures, oracle input traces, expected golden results and their checksums in Git. The small historical bad-rejection fixture contains only protocol rows consumed by its regression, not a full run log. These inputs are needed to reproduce the tests.

Runner JSON/JUnit, model rollouts, raw capture logs, mutation receipts, package archives and local review notes are generated output. They belong under ignored `/artifacts/` or an external results directory; `/test/evidence/` is ignored. CI uploads reports as Actions artifacts. Vendor instruction prose in captured mock requests/rollouts is replaced with hashes. Review redaction before publishing additional evidence.

Useful output overrides:

- `DEV01_REPORT_DIR`: runner JSON/JUnit and gate summaries (default `artifacts/runs`).
- `DEV01_EVIDENCE_DIR`: real-binary protocol captures (default `artifacts/evidence`).
- `DEV01_MUTATION_DIR`: mutation results (default `artifacts/mutation`).

Author tools are under `scripts/dev01/`. The execution-status tool verifies external reports; it does not rewrite the source matrix to claim passes from an old run.

## Gate contracts

- `test/parity-matrix.json` inventories features and named future contracts. `it.todo` entries represent work to do; they are never passing tests. Historical `passed` snapshots have been removed. The original mandatory verification rows remain marked `requiredVerification`; the parity gate must re-run and verify every referenced case.
- The parity gate removes stale JUnit before running. Child errors, signals, collection errors, missing cases and failed/skipped duplicates cannot approve it. Claims are checked against the current clean 40-character commit and runner Node/platform/architecture. A dirty working tree can be used for debugging, but cannot supply a verified-head pass.
- Parameterized references must match at least one observed expansion and every observed expansion must pass. Persisted pass receipts additionally require an existing JSON evidence file with matching clean head and explicit profile.
- Milestone selections are parsed fail-closed. Unknown/malformed selections fail, absent evidence stays pending, and M3 item selection/owner waivers remain pending an external authenticated verifier. Agreement between linter and evaluator alone is not proof; normative fixtures provide a separate anchor.
- Independent delivery seals are trusted tester inputs, not cryptographic attestations. Removing captures without a matching inventory cannot improve the verdict. A jointly falsified collector and its seal cannot be detected downstream. Unsupported expected outcomes fail before adjudication.
- Mutation controls must pass unmodified, then fail an executed assertion for the injected defect. Missing files, setup/collection errors, signals and unknown mutation IDs do not count as kills. All twelve controls run in CI.
- The egress scanner follows callable declaration identity and a cycle-safe capability graph, including renamed mapped properties, nested namespace values and tagged-template substitutions. Same-signature unrelated functions do not become guarded merely by structural equivalence. It scans JS/TS module extensions, rejects unresolved dynamic loaders and missing boundaries, and exposes analysis counters with an explicit repository budget. Counts are a coarse permitted-reference baseline, not a claim to authenticate each call by its line number; stale `lines` fields were removed.
- Source scope is measured against the reviewed main integration base in `test/pins.json`, independently of historical protocol pin `A`. Rebase updates that integration pin. Ignored files under `src/` are included in the scope proof. Missing Git objects fail the check.
- Package smoke installs the actual tarball, loads native SQLite and invokes the CLI. It also requires the executable JSONL proxy, checks that packaged modules have production source counterparts, and excludes test code/hooks/fixtures.
- Downgrade smoke builds historical source with that source's own lockfile/dependencies. Table and column identifiers are validated before SQL construction; the populated-baseline tests assert original tables are present rather than treating matching missing tables as proof.

## Reproduce golden results

Use clean source checkouts at the exact `B` and `OC` commits in `test/pins.json`; no source is downloaded or executed implicitly by the generators.

```sh
node scripts/goldens/gen-b.mjs --b /path/to/pinned/openclaw-channel-octo --check
node scripts/goldens/gen-oc-schedule.mjs --oc /path/to/pinned/openclaw --check
```

Omit `--check` only when intentionally regenerating reviewed golden inputs. The OC generator keeps the same array shared with its stub modules when resetting between module initialization and vector evaluation. Any later stub call fails generation; `stubCallsDuringVectors` is measured. Checksums alone establish internal consistency, while regeneration from the pinned upstream sources establishes provenance.

Validation results and review reconciliation are recorded in the PR. These instructions do not certify unimplemented contracts, live platform behavior or formal reviewer approval.
