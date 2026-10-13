#!/usr/bin/env node
/**
 * Mutation negative controls for the DEV-01 locks. Each mutation re-introduces a
 * B defect or breaks a locked A behavior in a throwaway copy of the working tree;
 * the named lock tests must then FAIL with an executed assertion (not a load
 * error), and the unmutated copy must pass. Results are written to
 * test/evidence/dev01/mutation/.
 *   node scripts/ci/mutation-check.mjs [mutationId ...]
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Current-run output (default: git-ignored artifacts/mutation); the committed
// snapshot under test/evidence/dev01/mutation is not rewritten.
const OUT = resolve(ROOT, process.env.DEV01_MUTATION_DIR ?? join('artifacts', 'mutation'));

export const MUTATIONS = [
  { id: 'M01-ack-before-decrypt', rows: ['BX-1', 'T10', 'INV-P3'], file: 'src/octo/socket.ts',
    find: '    let payloadObj: Record<string, unknown> | undefined;\n    try {', replace: '    this.sendRaw(encodeRecvackPacket(messageID, messageSeq));\n    let payloadObj: Record<string, unknown> | undefined;\n    try {',
    tests: ['test/locks/bx-locks.test.ts', 'test/integration/fake-octo-transport.test.ts'], filter: 'BX-1|FO-03' },
  { id: 'M02-math-random-dh-seed', rows: ['BX-3', 'T5'], file: 'src/octo/socket.ts',
    find: 'const seed = randomBytes(32);', replace: 'const seed = Uint8Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));',
    tests: ['test/locks/bx-locks.test.ts'], filter: 'BX-3' },
  { id: 'M03-unbounded-buffer', rows: ['BX-2', 'T4'], file: 'src/octo/socket.ts',
    find: 'if (this.tempBuffer.length > MAX_TEMP_BUFFER_BYTES) {', replace: 'if (false && this.tempBuffer.length > MAX_TEMP_BUFFER_BYTES) {',
    tests: ['test/locks/bx-locks.test.ts'], filter: 'BX-2' },
  { id: 'M04-unencoded-group-path', rows: ['BX-5', 'R6', 'EP-13'], file: 'src/octo/api.ts',
    find: '`/v1/bot/groups/${encodeURIComponent(params.groupNo)}/members`', replace: '`/v1/bot/groups/${params.groupNo}/members`',
    tests: ['test/locks/bx-locks.test.ts', 'test/locks/reuse-locks.test.ts'], filter: 'BX-5|EP-13' },
  { id: 'M05-missing-robot-flag-is-human', rows: ['BX-7', 'I12'], file: 'src/mention-prefs.ts',
    find: 'if (robot === 0 || robot === false) humans.add(member.uid);', replace: 'if (robot !== 1 && robot !== true) humans.add(member.uid);',
    tests: ['test/locks/bx-locks.test.ts'], filter: 'BX-7' },
  { id: 'M06-pref-invalidation-from-anyone', rows: ['BX-8', 'I13', 'EP-28'], file: 'src/session-router.ts',
    find: '        && msg.from_uid === this.robotId\n', replace: '\n',
    tests: ['test/locks/bx-locks.test.ts', 'test/locks/reuse-locks.test.ts'], filter: 'BX-8|EP-28' },
  { id: 'M07-lock-release-without-nonce', rows: ['INV-C5'], file: 'src/gateway.ts',
    find: '        if (nonce === this.lockNonce) {', replace: '        if (nonce !== undefined) {',
    tests: ['test/locks/invariant-locks.test.ts'], filter: 'INV-C5' },
  { id: 'M08-mention-all-every-segment', rows: ['O10'], file: 'src/stream-relay.ts',
    find: 'if (useMentionAll) mentionAllConsumed = true;', replace: 'if (useMentionAll) mentionAllConsumed = false;',
    tests: ['test/locks/reuse-locks.test.ts'], filter: 'O10' },
  { id: 'M09-proto-version', rows: ['T1', 'INV-P1'], file: 'src/octo/socket.ts',
    find: 'const PROTO_VERSION = 4;', replace: 'const PROTO_VERSION = 3;',
    tests: ['test/goldens/b-wire.golden.test.ts', 'test/locks/invariant-locks.test.ts'], filter: 'GB-04|INV-P1' },
  { id: 'M10-unsupported-channel-admitted', rows: ['I1', 'I2'], file: 'src/session-router.ts',
    find: 'return channelType === ChannelType.DM || this.isGroupLike(channelType);', replace: 'return channelType !== undefined;',
    tests: ['test/locks/reuse-locks.test.ts'], filter: 'I1' },
  { id: 'M11-new-egress-bypass', rows: ['HB-B5'], file: 'src/commands.ts',
    find: "export function handleCommand(", replace: "import { sendMessage } from './octo/api.js';\nexport const bypass = sendMessage;\nexport function handleCommand(",
    tests: ['test/egress/egress-bypass-scan.test.ts'], filter: 'EG-02' },
  { id: 'M12-self-echo-not-filtered', rows: ['T23'], file: 'src/gateway.ts',
    find: "    if (msg.from_uid === this.robotId && msg.payload.event?.type !== 'mention_pref_updated'", replace: "    if (false && msg.from_uid === this.robotId && msg.payload.event?.type !== 'mention_pref_updated'",
    tests: ['test/locks/reuse-locks.test.ts'], filter: 'T23' },
];

function copyTree() {
  const dir = mkdtempSync(join(tmpdir(), 'dev01-mut-'));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => !/\/(node_modules|\.git|\.cache|dist|dist-test|coverage)(\/|$)/.test(src.slice(ROOT.length)) });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}
function runTests(dir, m) {
  const r = spawnSync(process.execPath, [join(dir, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...m.tests, '-t', m.filter, '--reporter=json'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let report;
  try { report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { report = null; }
  const cases = (report?.testResults ?? []).flatMap((f) => f.assertionResults.map((a) => ({ file: f.name.slice(dir.length + 1), title: a.fullName, status: a.status, failure: (a.failureMessages ?? []).join('\n').split('\n')[0] })));
  const loadErrors = (report?.testResults ?? []).filter((f) => f.status === 'failed' && f.assertionResults.length === 0).map((f) => f.message);
  return { exit: r.status, cases, loadErrors };
}

const only = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const summary = [];
const control = copyTree();
try {
  for (const m of MUTATIONS.filter((x) => only.length === 0 || only.includes(x.id))) {
    const baseline = runTests(control, m);
    const dir = copyTree();
    try {
      const path = join(dir, m.file);
      const text = readFileSync(path, 'utf8');
      if (!text.includes(m.find)) throw new Error(`${m.id}: mutation anchor not found in ${m.file}`);
      writeFileSync(path, text.replace(m.find, m.replace));
      const mutated = runTests(dir, m);
      const executedFailures = mutated.cases.filter((c) => c.status === 'failed');
      const killed = executedFailures.length > 0 && mutated.loadErrors.length === 0;
      const controlPassed = baseline.cases.some((c) => c.status === 'passed') && !baseline.cases.some((c) => c.status === 'failed') && baseline.loadErrors.length === 0;
      const result = { id: m.id, rows: m.rows, file: m.file, filter: m.filter, controlPassed, killed, executedFailures, mutatedLoadErrors: mutated.loadErrors, controlCases: baseline.cases.length };
      writeFileSync(join(OUT, `${m.id}.json`), JSON.stringify(result, null, 2) + '\n');
      summary.push({ id: m.id, rows: m.rows, controlPassed, killed, failingCases: executedFailures.map((c) => c.title) });
      console.log(`${m.id}: control ${controlPassed ? 'pass' : 'FAIL'} / mutant ${killed ? 'killed by executed assertion' : 'SURVIVED'}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(control, { recursive: true, force: true });
}
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, mutations: summary }, null, 2) + '\n');
process.exit(summary.every((s) => s.controlPassed && s.killed) ? 0 : 1);
