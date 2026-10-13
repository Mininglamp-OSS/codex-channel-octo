/**
 * Source provenance for runner records. Captured BEFORE execution so outputs a
 * run writes cannot change it. Generated evidence (committed snapshots under
 * test/evidence/ and the git-ignored artifacts/ output tree) is not source;
 * executable evidence tooling is source and is never excluded.
 * every other tracked or untracked path (src, test code, fixtures, goldens,
 * config, lockfile, workflow) counts. A dirty source tree is reported as
 * `<sha>+dirty` and never as a clean head.
 */
import { execFileSync } from 'node:child_process';

export const GENERATED_PREFIXES = ['test/evidence/', 'artifacts/'];

/** @param {string} root @param {(args: string[]) => string} [git] */
export function captureSourceState(root, git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })) {
  let sha = 'unknown';
  try { sha = git(['rev-parse', 'HEAD']).trim(); } catch { /* not a git checkout */ }
  let porcelain = '';
  try { porcelain = git(['status', '--porcelain', '-uall', '--no-renames']); } catch { porcelain = '?? <git status unavailable>'; }
  const changed = porcelain.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''));
  const dirtyPaths = changed.filter((p) => {
    const evidenceTool = p.startsWith('test/evidence/') && (p.includes('/tools/') || /\.(?:[cm]?[jt]sx?|py|sh)$/.test(p));
    return evidenceTool || !GENERATED_PREFIXES.some((g) => p.startsWith(g));
  });
  const ignoredGenerated = changed.length - dirtyPaths.length;
  return { sha, dirty: dirtyPaths.length > 0, head: sha + (dirtyPaths.length > 0 ? '+dirty' : ''), dirtyPaths, ignoredGenerated };
}
