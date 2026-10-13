# DEV-01 RED evidence (pinned baseline dd12980)

`red-run.log` / `red-junit.xml`: `npx vitest run test` executed on the unmodified
pinned tree (`head.txt`: HEAD dd1298083d014d8e82376c01edb38a2e6914366f, no src /
package.json / vitest.config.ts / .github changes, Node v26.5.0) with only the new
test files present.

Classification: **infrastructural RED (module load failures)**. All 17 new test
files fail before executing any assertion because the seams (`src/seams/*`),
harness modules, generators and data artifacts did not exist yet
(`ERR_MODULE_NOT_FOUND`). No assertion executed in those files, so this log is
NOT evidence of behavioral failure. The 55 baseline files / 1178 tests passed in
the same run.

Executed-assertion RED and mutation negative controls are recorded separately in
`../red-executed/` and `../mutation/`.
