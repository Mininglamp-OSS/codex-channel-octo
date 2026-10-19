/**
 * CI shape (R8 §10.2) and DEV-01 scope proofs: triggers on every branch,
 * required jobs, src diff limited to interface seams, packaged tarball free of
 * test hooks, pins exact.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { checkSrcDiff } from '../../scripts/ci/check-src-diff.mjs';
import { parseTestHookEnv } from '../hooks/test-hooks.js';
import { pins } from '../harness/pins.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const wf = yaml.load(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as {
  on: Record<string, unknown>; concurrency: { group: string; 'cancel-in-progress': boolean }; jobs: Record<string, { 'runs-on': string; strategy?: { matrix?: Record<string, unknown> }; steps: Array<Record<string, unknown>> }>;
};
const runs = (job: string) => wf.jobs[job].steps.map((s) => String(s.run ?? '')).join('\n');

describe('CI workflow', () => {
  it('CI-01: push and pull_request on all branches plus workflow_dispatch', () => {
    expect(wf.on).toHaveProperty('workflow_dispatch');
    expect(wf.concurrency['cancel-in-progress']).toBe(true);
    expect(wf.concurrency.group).toContain('github.event.pull_request.head.sha || github.sha');
    expect(wf.on.push).toEqual({ branches: ['**'] });
    expect(wf.on.pull_request).toEqual({ branches: ['**'] });
  });

  it('CI-02: unit runs on a Node 22 / 24 matrix and uploads runner records', () => {
    expect(wf.jobs.unit.strategy?.matrix?.node).toEqual(['22', '24.10.0']);
    expect(runs('unit')).toMatch(/npm test/);
  });

  it('CI-03: the R8 §10.2 jobs exist with their commands', () => {
    for (const j of ['type-check', 'lint', 'unit', 'real-binary', 'pack-smoke', 'parity-matrix', 'egress-bypass-scan', 'downgrade-open', 'goldens', 'src-scope', 'build', 'latest-sdk', 'mutation']) {
      expect(wf.jobs, j).toHaveProperty(j);
    }
    expect(wf.jobs['real-binary']['runs-on']).toBe('ubuntu-latest');
    expect(runs('real-binary')).toContain('scripts/ci/run-runner.mjs real-binary -c test/real-binary/vitest.config.ts');
    expect(runs('real-binary')).toContain('unshare --net');
    expect(runs('real-binary')).toContain('runuser -u "$SUDO_USER"');
    expect(runs('mutation')).toContain('npm run test:mutation');
    expect(runs('build')).toContain('dist/codex-jsonl-proxy.mjs');
    expect(JSON.stringify(wf.jobs['real-binary'])).toMatch(/NO_PROXY/);
    expect(runs('pack-smoke')).toMatch(/npm run pack:smoke/);
    expect(wf.jobs['pack-smoke'].strategy?.matrix?.node).toEqual(['22', '24.10.0']);
    expect(runs('parity-matrix')).toMatch(/npm run test:parity-matrix/);
    expect(runs('egress-bypass-scan')).toMatch(/npm run test:egress/);
    expect(runs('downgrade-open')).toMatch(/npm run test:downgrade/);
    expect(runs('goldens')).toMatch(/npm run goldens:verify/);
    // Workflow env keys are case-insensitive, even for Linux jobs.
    for (const job of Object.values(wf.jobs)) {
      for (const section of [job, ...job.steps]) {
        const keys = Object.keys((section as { env?: Record<string, string> }).env ?? {});
        expect(new Set(keys.map((key) => key.toLowerCase())).size).toBe(keys.length);
      }
    }
  });

  it('CI-04: package.json exposes the DEV-01 runners', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string>; files: string[] };
    for (const s of ['test:real-binary', 'test:parity-matrix', 'test:goldens', 'test:downgrade', 'test:integration', 'test:egress', 'build:test', 'pack:smoke', 'goldens:verify']) {
      expect(pkg.scripts, s).toHaveProperty(s);
    }
    expect(pkg.files).not.toContain('dist-test');
    expect(pkg.files.some((f) => f.startsWith('test'))).toBe(false);
  });
});

describe('CI provenance', () => {
  type Step = Record<string, unknown> & { uses?: string; with?: Record<string, unknown>; env?: Record<string, string> };
  const steps = Object.entries(wf.jobs).flatMap(([job, j]) => (j.steps as Step[]).map((s) => ({ job, s })));
  const HEAD_REF = '${{ github.event.pull_request.head.sha || github.sha }}';

  it('CI-09: every candidate-repo checkout uses the actual PR head SHA (never the synthesized merge ref); B/OC stay pinned', () => {
    const checkouts = steps.filter(({ s }) => String(s.uses ?? '').startsWith('actions/checkout@'));
    const candidate = checkouts.filter(({ s }) => !s.with?.repository);
    expect(candidate.length).toBe(Object.keys(wf.jobs).length);
    for (const { job, s } of candidate) {
      expect(s.with?.ref, job).toBe(HEAD_REF);
      // Default unit tests archive the pinned parent and compare src against it.
      expect(s.with?.['fetch-depth'], `${job}: pinned parent must be available`).toBe(0);
    }
    const pinned = Object.fromEntries(checkouts.filter(({ s }) => s.with?.repository).map(({ s }) => [s.with!.repository, s.with!.ref]));
    expect(pinned).toEqual({ 'Mininglamp-OSS/openclaw-channel-octo': pins.B, 'openclaw/openclaw': pins.OC });
  });

  it('CI-10: runner outputs go to artifacts/ (never committed evidence) and every uploaded path is one a step writes', () => {
    const uploads = steps.filter(({ s }) => String(s.uses ?? '').startsWith('actions/upload-artifact@'));
    expect(uploads.length).toBeGreaterThan(0);
    for (const { job, s } of uploads) {
      const written = new Set(steps.filter(x => x.job === job).flatMap(x => Object.values(x.s.env ?? {})).map(v => `${v.replace(/\/$/, '')}/`));
      const paths = String(s.with?.path ?? '').split('\n').map(x => x.trim()).filter(Boolean);
      expect(paths.length, job).toBeGreaterThan(0);
      for (const p of paths) { expect(p.startsWith('artifacts/'), job).toBe(true); expect(written.has(p), `${job}: ${p}`).toBe(true); }
    }
    expect(JSON.stringify(wf)).not.toMatch(/test\/evidence\/dev01\/(runs|real-binary)/);
  });

  it('CI-11: the parity gate runs a fresh full unit selection and validates its own fresh JUnit', () => {
    const gate = readFileSync(new URL('../../scripts/ci/parity-matrix-gate.mjs', import.meta.url), 'utf8');
    expect(gate).toMatch(/spawn\(process\.execPath, \['scripts\/ci\/run-runner\.mjs', runner\]/); // no path filter → full default suite
    expect(gate).toMatch(/rmSync\(junitPath/);
    expect(gate).not.toMatch(/test\/evidence/);
  });
});

describe('DEV-01 scope', () => {
  it('CI-05: relative to the reviewed main integration base, src changes are limited to the reviewed interface-seam allowlist', () => {
    const r = checkSrcDiff({ root: ROOT });
    expect(r.violations).toEqual([]);
    expect(r.allowlist).toEqual(['src/seams/clock.ts', 'src/seams/fault-plan.ts']);
  });

  it('CI-06: negative control — any other src path fails the scope check', () => {
    const r = checkSrcDiff({ root: ROOT, base: pins.A, changes: [{ status: 'M', path: 'src/gateway.ts' }, { status: 'A', path: 'src/seams/clock.ts' }, { status: 'A', path: 'src/egress/index.ts' }] });
    expect(r.violations.map((v: { path: string }) => v.path)).toEqual(['src/gateway.ts', 'src/egress/index.ts']);
  });

  it('CI-07: the test-hook parser is test-build only and fails closed on malformed input', () => {
    expect(existsSync(new URL('../../src/test-hooks.ts', import.meta.url))).toBe(false);
    expect(parseTestHookEnv({})).toEqual({ faults: [], clockOffsetMs: 0 });
    expect(parseTestHookEnv({ CODEX_OCTO_TEST_FAULTS: '[{"point":"runtime.killChild","times":1}]', CODEX_OCTO_TEST_CLOCK: '3600000' }))
      .toEqual({ faults: [{ point: 'runtime.killChild', times: 1 }], clockOffsetMs: 3_600_000 });
    expect(() => parseTestHookEnv({ CODEX_OCTO_TEST_FAULTS: '[{"point":"nope"}]' })).toThrow(/unknown fault point/);
    expect(() => parseTestHookEnv({ CODEX_OCTO_TEST_CLOCK: 'soon' })).toThrow(/CODEX_OCTO_TEST_CLOCK/);
  });

  it('CI-08: pins are exact and the binary/SDK versions are locked at 0.142.3', () => {
    expect(pins).toMatchObject({
      A: 'dd1298083d014d8e82376c01edb38a2e6914366f', B: '2e710e903fa43ac9440723746f7395d2f7b4347e',
      OC: 'f6065d67762f2c87fbdeff119f34f54266a95b87', codex: '0.142.3', croner: '10.0.1',
    });
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { version: string }> };
    expect(lock.packages['node_modules/codex-contract-cli'].version).toBe('0.142.3');
    expect(lock.packages['node_modules/@openai/codex-sdk'].version).toMatch(/^0\.\d+\./);
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.dependencies['@openai/codex-sdk']).toBe('latest');
    expect(lock.packages['node_modules/croner'].version).toBe('10.0.1');
  });
});
