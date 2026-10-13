#!/usr/bin/env node
/**
 * Run a vitest selection as a named DEV-01 runner emitting R8 §10.1 records
 * (JSON + JUnit) to $DEV01_REPORT_DIR (default: git-ignored artifacts/runs).
 * Source provenance is captured before the run and passed to the reporter.
 *   node scripts/ci/run-runner.mjs <runner> [vitest args...]
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { captureSourceState } from './source-state.mjs';

const [runner, ...args] = process.argv.slice(2);
if (!runner) { console.error('usage: run-runner.mjs <runner> [vitest args]'); process.exit(2); }
const state = captureSourceState(process.cwd());
const r = spawnSync(process.execPath, [join('node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=default', '--reporter=./test/harness/report/case-reporter.ts', ...args], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DEV01_RUNNER: runner,
    DEV01_REPORT_DIR: process.env.DEV01_REPORT_DIR ?? join('artifacts', 'runs'),
    DEV01_EVIDENCE_DIR: process.env.DEV01_EVIDENCE_DIR ?? join('artifacts', 'evidence'),
    DEV01_SOURCE_STATE: JSON.stringify(state),
  },
});
process.exit(r.status ?? 1);
