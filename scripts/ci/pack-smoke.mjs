#!/usr/bin/env node
/**
 * Pack smoke (R8 §8.3, §10.2): build, `npm pack`, assert the tarball carries no
 * test hooks / harness / correlation decorator, install it into a clean
 * directory, load the native better-sqlite3 binding and run the CLI.
 * Emits an R8 §10.1 record to $DEV01_REPORT_DIR/pack-smoke-node<major>.results.json
 * (default: git-ignored artifacts/runs). Source provenance is captured before
 * the build so pack outputs cannot change it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { captureSourceState } from './source-state.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const start = new Date().toISOString();
const sourceState = captureSourceState(ROOT);
const OUT_DIR = join(ROOT, process.env.DEV01_REPORT_DIR ?? join('artifacts', 'runs'));
const OUT_FILE = join(OUT_DIR, `pack-smoke-node${process.versions.node.split('.')[0]}.results.json`);
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); if (!ok) console.error(`pack-smoke: FAIL ${name} ${detail}`); };
const work = mkdtempSync(join(tmpdir(), 'dev01-pack-'));
let status = 'failed';
try {
  execFileSync(npm, ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync(npm, ['run', 'build:test'], { cwd: ROOT, stdio: 'inherit' });
  check('test hook module exists locally (built for test)', existsSync(join(ROOT, 'dist-test', 'test', 'hooks', 'test-hooks.js')));
  const packed = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', work], { cwd: ROOT, encoding: 'utf8' }))[0];
  const tgz = join(work, packed.filename);
  const files = packed.files.map((f) => f.path);
  check('no dist-test / test hooks in tarball', !files.some((f) => /(^|\/)dist-test\/|test-hooks/.test(f)), files.filter((f) => /test-hooks|dist-test/.test(f)).join(','));
  check('no test/ or harness sources in tarball', !files.some((f) => /^test\/|(^|\/)harness\//.test(f)));
  const unpack = join(work, 'unpacked');
  mkdirSync(unpack);
  execFileSync('tar', ['-xzf', tgz, '-C', unpack]);
  const jsFiles = files.filter((f) => f.endsWith('.js'));
  const leaks = jsFiles.filter((f) => /\[DLY |CODEX_OCTO_TEST_FAULTS|CODEX_OCTO_TEST_CLOCK|ScriptedFaultPlan|FakeClock/.test(readFileSync(join(unpack, 'package', f), 'utf8')));
  check('no correlation marker or test-hook symbols in packaged JS', leaks.length === 0, leaks.join(','));
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), '{"name":"pack-smoke","version":"0.0.0","private":true}');
  execFileSync(npm, ['install', tgz, '--no-audit', '--no-fund', '--omit=dev'], { cwd: app, stdio: 'inherit' });
  const pkgDir = join(app, 'node_modules', '@mininglamp-oss', 'codex-channel-octo');
  const req = createRequire(join(pkgDir, 'package.json'));
  const Database = req('better-sqlite3');
  const db = new Database(':memory:');
  const one = db.prepare('select 1 as v').get().v;
  db.close();
  check('native better-sqlite3 loads from the installed package', one === 1);
  const bin = join(app, 'node_modules', '.bin', process.platform === 'win32' ? 'codex-channel-octo.cmd' : 'codex-channel-octo');
  const v = spawnSync(bin, ['version'], { encoding: 'utf8' });
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  check('installed CLI `codex-channel-octo version` prints the package version', v.status === 0 && v.stdout.trim() === version, `${v.status} ${v.stdout.trim()} ${v.stderr.trim()}`);
  status = checks.every((c) => c.ok) ? 'passed' : 'failed';
} catch (e) {
  checks.push({ name: 'exception', ok: false, detail: String(e) });
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(join(ROOT, 'dist-test'), { recursive: true, force: true });
}
const head = sourceState.head;
const record = {
  caseId: 'PACK-SMOKE', pin: JSON.parse(readFileSync(join(ROOT, 'test', 'pins.json'), 'utf8')), head,
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  preconditions: 'R8 §8.3/§10.2 pack-smoke', steps: ['npm run build', 'npm run build:test', 'npm pack', 'inspect tarball', 'npm install <tgz> in a clean dir', 'load better-sqlite3', 'codex-channel-octo version'],
  expected: 'all checks pass', actual: checks, start, end: new Date().toISOString(), status, evidencePaths: [OUT_FILE.slice(ROOT.length + 1)],
};
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify({ runner: 'pack-smoke', head, records: [record] }, null, 2) + '\n');
console.log(JSON.stringify({ status, checks }, null, 2));
process.exit(status === 'passed' ? 0 : 1);
