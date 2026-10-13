/**
 * Runner provenance (R8 §10.1 head/pin fields): source state is captured before
 * execution, generated evidence never marks a clean source tree dirty, and any
 * source/config/fixture change keeps the `+dirty` suffix.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureSourceState } from '../../scripts/ci/source-state.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'dev01-src-state-'));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  git('init', '-q');
  for (const [p, c] of [['src/a.ts', 'export const a = 1;\n'], ['test/fixtures/f.json', '{}\n'], ['test/evidence/dev01/runs/unit.junit.xml', '<old/>\n'], ['package.json', '{}\n']]) {
    mkdirSync(join(d, p, '..'), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  return { d, sha: git('rev-parse', 'HEAD').trim() };
}

describe('source state', () => {
  it('SS-01: a clean source tree stays clean when generated evidence and artifacts change', () => {
    const { d, sha } = repo();
    writeFileSync(join(d, 'test/evidence/dev01/runs/unit.junit.xml'), '<new/>\n');
    mkdirSync(join(d, 'test/evidence/dev01/real-binary/SB-01'), { recursive: true });
    writeFileSync(join(d, 'test/evidence/dev01/real-binary/SB-01/x.jsonl'), '{}\n');
    mkdirSync(join(d, 'artifacts/runs'), { recursive: true });
    writeFileSync(join(d, 'artifacts/runs/r.json'), '{}\n');
    const s = captureSourceState(d);
    expect(s).toMatchObject({ sha, dirty: false, head: sha, dirtyPaths: [] });
    expect(s.ignoredGenerated).toBeGreaterThanOrEqual(2);
  });

  it('SS-02: source, fixture, config and untracked test changes are dirty', () => {
    for (const [path, content] of [['src/a.ts', 'export const a = 2;\n'], ['test/fixtures/f.json', '{"x":1}\n'], ['package.json', '{"a":1}\n'], ['test/new.test.ts', '//\n'], ['test/evidence/dev01/tools/generator.mjs', 'export const pin = 1;\n'], ['test/evidence/dev01/custom-generator.py', 'print(1)\n']] as const) {
      const { d, sha } = repo();
      mkdirSync(join(d, path, '..'), { recursive: true });
      writeFileSync(join(d, path), content);
      const s = captureSourceState(d);
      expect(s.head, path).toBe(`${sha}+dirty`);
      expect(s.dirtyPaths, path).toEqual([path]);
    }
  });

  it('SS-03: an uncommitted interface seam is reported +dirty (never forged clean)', () => {
    const { d, sha } = repo();
    expect(captureSourceState(d).head).toBe(sha);
    mkdirSync(join(d, 'src/seams'), { recursive: true });
    writeFileSync(join(d, 'src/seams/clock.ts'), 'export interface Clock { now(): number }\n');
    const s = captureSourceState(d);
    expect(s.head).toBe(`${sha}+dirty`);
    expect(s.dirtyPaths.some((p: string) => p.startsWith('src/seams/'))).toBe(true);
  });

  it('SS-04: the runner honors DEV01_REPORT_DIR and records provenance captured before the run', () => {
    const out = mkdtempSync(join(tmpdir(), 'dev01-runner-out-'));
    dirs.push(out);
    const r = spawnSync(process.execPath, ['scripts/ci/run-runner.mjs', 'probe', 'test/seams'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DEV01_REPORT_DIR: out } });
    expect(r.status).toBe(0);
    expect(existsSync(join(out, 'probe.junit.xml'))).toBe(true);
    const rec = JSON.parse(readFileSync(join(out, 'probe.results.json'), 'utf8')) as { head: string; records: Array<{ head: string }> };
    expect(rec.head).toBe(captureSourceState(ROOT).head);
    expect(rec.records.every((x) => x.head === rec.head)).toBe(true);
  });
});
