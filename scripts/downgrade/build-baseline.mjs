#!/usr/bin/env node
/**
 * Build the dd12980 (or any pinned) package from its git object for the
 * downgrade-open harness (R8 §10.2). The tree is extracted with `git archive`
 * into .cache/downgrade/<commit>/ and compiled with its own locked dependencies; candidate dependencies never
 * stand in for the historical runtime.
 *   node scripts/downgrade/build-baseline.mjs [commit]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildBaseline({ root, commit }) {
  const dir = join(root, '.cache', 'downgrade', commit);
  const distDir = join(dir, 'dist');
  const marker = join(dir, '.built-from');
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === `${commit}:locked-deps-v1` && existsSync(join(distDir, 'session-store.js'))) {
    return { dir, commit, distDir };
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tar = execFileSync('git', ['-C', root, 'archive', '--format=tar', commit, 'src', 'package.json', 'package-lock.json', 'tsconfig.json'], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
  execFileSync(process.execPath, [join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(dir, 'tsconfig.json')], { stdio: 'inherit' });
  writeFileSync(marker, `${commit}:locked-deps-v1\n`);
  return { dir, commit, distDir };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const pins = JSON.parse(readFileSync(join(root, 'test', 'pins.json'), 'utf8'));
  console.log(JSON.stringify(buildBaseline({ root, commit: process.argv[2] ?? pins.A })));
}
