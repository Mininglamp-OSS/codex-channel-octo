/**
 * Vitest reporter that writes R8 §10.1 case records as JSON and JUnit.
 * Configure with env DEV01_RUNNER (runner name) and DEV01_REPORT_DIR
 * (defaults: "adhoc" in artifacts/runs).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildCaseRecords, toJUnit, type CatalogMeta } from './case-records.js';
import { captureSourceState } from '../../../scripts/ci/source-state.mjs';

type AnyTask = { type: string; tasks?: AnyTask[]; [k: string]: unknown };
const flatten = (t: AnyTask): AnyTask[] => {
  if (t.type === 'test') return [t];
  const result = t.result as { state?: string } | undefined;
  if (result?.state === 'fail') return [{ ...t, type: 'test', name: 'collection-error', file: { name: t.filepath ?? t.name } }, ...(t.tasks ?? []).flatMap(flatten)];
  return (t.tasks ?? []).flatMap(flatten);
};

function loadCatalog(): Record<string, CatalogMeta> {
  const out: Record<string, CatalogMeta> = {};
  const p = join(process.cwd(), 'test', 'acceptance', 'case-catalog.json');
  if (!existsSync(p)) return out;
  const cat = JSON.parse(readFileSync(p, 'utf8')) as { entries: Array<{ id: string; procedure: string; evidenceOracle: string; source: string }> };
  for (const e of cat.entries) out[e.id] = { preconditions: e.source, steps: e.procedure, expected: e.evidenceOracle };
  return out;
}

export default class CaseReporter {
  onFinished(files: AnyTask[] = [], errors: Array<{ message?: string }> = []): void {
    // Ad-hoc runs write to the git-ignored artifacts/ directory; the runner
    // scripts (scripts/ci/run-runner.mjs) set both variables explicitly.
    const runner = process.env.DEV01_RUNNER ?? 'adhoc';
    const dir = process.env.DEV01_REPORT_DIR ?? join('artifacts', 'runs');
    // Provenance captured by the runner before execution; ad-hoc runs capture it
    // now, which still excludes generated evidence/artifacts from dirtiness.
    const state = process.env.DEV01_SOURCE_STATE
      ? JSON.parse(process.env.DEV01_SOURCE_STATE) as { head: string }
      : captureSourceState(process.cwd());
    const head = state.head;
    const pins = JSON.parse(readFileSync(join(process.cwd(), 'test', 'pins.json'), 'utf8')) as unknown;
    const environment = { node: process.version, platform: process.platform, arch: process.arch, ci: Boolean(process.env.CI), runner };
    const tasks = [...files.flatMap(flatten), ...errors.map((e, i) => ({ type: 'test', name: `unhandled-error-${i}`, file: { name: '<runner>' }, result: { state: 'fail', errors: [e] } }))];
    const records = buildCaseRecords(tasks as never, { pins, head, environment, catalog: loadCatalog() });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${runner}.results.json`), JSON.stringify({ runner, head, environment, generatedAt: new Date().toISOString(), records }, null, 2) + '\n');
    writeFileSync(join(dir, `${runner}.junit.xml`), toJUnit(records, runner));
  }
}
