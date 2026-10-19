#!/usr/bin/env node
/**
 * DEV-01 scope proof (R8 §9 exit gate, §10.1): relative to the reviewed integration base (separate from historical pin A),
 * src/ may change only in the reviewed interface-seam allowlist.
 *   node scripts/ci/check-src-diff.mjs [base]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC_ALLOWLIST = ['src/seams/clock.ts', 'src/seams/fault-plan.ts'];

/**
 * @param {{ root: string, base?: string, changes?: Array<{ status: string, path: string }> }} opts
 * @returns {{ allowlist: string[], changes: Array<{ status: string, path: string }>, violations: Array<{ status: string, path: string }> }}
 */
export function checkSrcDiff({ root, base, changes }) {
  base ??= execFileSync('git', ['-C', root, 'merge-base', 'HEAD',
    JSON.parse(readFileSync(join(root, 'test', 'pins.json'), 'utf8')).integrationBase], { encoding: 'utf8' }).trim();
  let list = changes;
  if (!list) {
    const diff = execFileSync('git', ['-C', root, 'diff', '--name-status', base, '--', 'src'], { encoding: 'utf8' }).trim();
    const untracked = execFileSync('git', ['-C', root, 'ls-files', '--others', '--', 'src'], { encoding: 'utf8' }).trim();
    list = [
      ...diff.split('\n').filter(Boolean).map((l) => { const [status, ...p] = l.split('\t'); return { status, path: p.at(-1) }; }),
      ...untracked.split('\n').filter(Boolean).map((p) => ({ status: 'A', path: p })),
    ];
  }
  return { allowlist: SRC_ALLOWLIST, changes: list, violations: list.filter((c) => !SRC_ALLOWLIST.includes(c.path)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const base = process.argv[2];
  const r = checkSrcDiff({ root, base });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.violations.length ? 1 : 0);
}
