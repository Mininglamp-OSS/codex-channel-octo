# Executed-assertion RED evidence

Both variants copy the working tree to a throwaway directory and reset selected
files to the pinned parent dd1298083d014d8e82376c01edb38a2e6914366f.

* `variant-b-baseline-config.txt` (+ `variant-b-vitest-report.json`): tests and
  `src/seams` from the working tree, but `package.json`, `package-lock.json`,
  `.github/workflows/ci.yml` and `vitest.config.ts` from dd12980. 22 tests,
  0 load failures, 7 executed assertion failures:
  - CI-01 (no workflow_dispatch / main-only triggers), CI-02 (no unit Node 22/24
    matrix), CI-03 (missing R8 §10.2 jobs), CI-04 (missing DEV-01 runner
    scripts), CI-08 (croner 10.0.1 not locked) — behavioral RED on the baseline
    configuration, GREEN after the DEV-01 changes.
  - CI-05 failed because the throwaway copy has no `.git` directory
    (`git diff` cannot run): an environmental failure, NOT evidence about the
    src scope. CI-05/CI-06 pass in the real worktree.
  - PM-05 (R8 requires 27 octo_management actions; pinned B source has 24):
    stays RED after implementation by design — open blocker R8-MGMT-27.
* `variant-a-no-seams.txt`: additionally removes `src/seams`. Six files then
  fail at module load (infrastructural, no assertion executed); recorded only to
  show which suites depend on the seams.

Lock suites (reuse/bx/invariant/capability locks) pin existing dd12980 behavior,
so they are GREEN on the baseline by design. Their meaningfulness is shown by
mutation negative controls in `../mutation/` (each mutant re-introduces a B defect
or breaks a locked behavior and is killed by an executed assertion while the
unmutated control passes).
