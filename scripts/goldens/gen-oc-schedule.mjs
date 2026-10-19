#!/usr/bin/env node
/**
 * Generate OC schedule goldens by executing pinned openclaw source with
 * croner@10.0.1 (R8 §3.4.6, §3.4.8, §10.3).
 *
 *   node scripts/goldens/gen-oc-schedule.mjs [--oc <path to openclaw checkout>] [--check]
 *
 * - Verifies the OC checkout HEAD equals test/pins.json "OC" and the installed
 *   croner is exactly test/pins.json "croner"; records source sha256s and the
 *   Node/ICU/tzdata versions (timezone rules come from the runtime's ICU).
 * - Bundles src/cron/schedule.ts, src/cron/stagger.ts and
 *   src/cron/service/jobs-scheduling.ts unmodified with esbuild; only an
 *   export statement is appended to jobs-scheduling.ts for its module-private
 *   effective-slot wrappers.
 * - Values are never hand-computed here: every next/previous instant is the
 *   pinned function's output.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { beginVectors, assertPureVectors } from './stub-purity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(ROOT, 'package.json'));
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OC = resolve(argVal('--oc', join(ROOT, '..', 'openclaw')));
const CHECK = args.includes('--check');
const OUT = join(ROOT, 'test', 'goldens', 'oc');
const pins = JSON.parse(readFileSync(join(ROOT, 'test', 'pins.json'), 'utf8'));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const fail = (m) => { console.error(`gen-oc-schedule: ${m}`); process.exit(1); };

const head = execFileSync('git', ['-C', OC, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== pins.OC) fail(`OC checkout HEAD ${head} != pinned ${pins.OC}`);
const FILES = ['src/cron/schedule.ts', 'src/cron/stagger.ts', 'src/cron/service/jobs-scheduling.ts'];
const dirty = execFileSync('git', ['-C', OC, 'status', '--porcelain', '--', ...FILES, 'packages/normalization-core'], { encoding: 'utf8' }).trim();
if (dirty) fail(`OC source files are modified:\n${dirty}`);
const cronerVersion = require('croner/package.json').version;
if (cronerVersion !== pins.croner) fail(`installed croner ${cronerVersion} != pinned ${pins.croner}`);
const ocCroner = JSON.parse(readFileSync(join(OC, 'package.json'), 'utf8')).dependencies?.croner;
if (ocCroner !== pins.croner) fail(`OC package.json pins croner ${ocCroner}, expected ${pins.croner}`);

const sources = Object.fromEntries(FILES.map((f) => [f, sha256(readFileSync(join(OC, f)))]));
const SHIM = '\nexport { computeStaggeredCronNextRunAtMs, computeStaggeredCronPreviousRunAtMs, computeStaggeredCronPreviousRunAtOrBeforeMs, resolveStableCronOffsetMs };\n';
const NC = join(OC, 'packages', 'normalization-core', 'src');
const cacheDir = join(ROOT, '.cache', 'goldens');
mkdirSync(cacheDir, { recursive: true });
const entry = join(cacheDir, 'oc-entry.ts');
writeFileSync(entry, [
  `export { computeNextRunAtMs, computePreviousRunAtMs } from ${JSON.stringify(join(OC, 'src/cron/schedule.ts'))};`,
  `export { resolveDefaultCronStaggerMs, resolveCronStaggerMs } from ${JSON.stringify(join(OC, 'src/cron/stagger.ts'))};`,
  `export * from ${JSON.stringify(join(OC, 'src/cron/service/jobs-scheduling.ts'))};`,
].join('\n'));
const bundlePath = join(cacheDir, 'oc-schedule.bundle.mjs');
const stubbed = new Set();
/** Named imports of a stubbed specifier across the OC tree (static scan). */
const importIndex = new Map();
(function scan(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) scan(p);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(/(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
        const set = importIndex.get(m[2]) ?? new Set();
        for (const part of m[1].split(',')) {
          const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) set.add(name);
        }
        importIndex.set(m[2], set);
      }
    }
  }
})(OC);
const stubExportNames = (spec) => [...(importIndex.get(spec) ?? [])].filter((n) => n !== 'default').sort();
await esbuild.build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: bundlePath, logLevel: 'error',
  external: ['croner'],
  plugins: [{
    name: 'oc-workspace',
    setup(build) {
      build.onResolve({ filter: /^@openclaw\/normalization-core(\/.*)?$/ }, (a) => {
        const sub = a.path.replace(/^@openclaw\/normalization-core\/?/, '') || 'index';
        const p = join(NC, `${sub}.ts`);
        if (!existsSync(p)) fail(`cannot resolve ${a.path}`);
        return { path: p };
      });
      // Host packages that jobs-scheduling.ts imports transitively (logging,
      // filesystem guards, schema validation) but that the schedule/stagger
      // functions never call. They are replaced by call-recording stubs; any
      // stub invocation while vectors are computed fails the generation.
      build.onResolve({ filter: /^(@openclaw\/fs-safe(\/.*)?|typebox(\/.*)?|chalk|tslog|string-width)$/ }, (a) => {
        stubbed.add(a.path);
        return { path: a.path, namespace: 'oc-stub' };
      });
      build.onLoad({ filter: /.*/, namespace: 'oc-stub' }, (a) => {
        const names = stubExportNames(a.path);
        const lines = [
          `const calls = (globalThis.__ocStubCalls ??= []);`,
          `const make = (path) => new Proxy(function () {}, {`,
          `  get: (_t, k) => (k === Symbol.toPrimitive ? () => path : k === 'then' ? undefined : make(path + '.' + String(k))),`,
          `  apply: () => { calls.push(path); return make(path + '()'); },`,
          `  construct: () => { calls.push('new ' + path); return make(path + '#instance'); },`,
          `});`,
          ...names.map((n) => `export const ${n} = make(${JSON.stringify(a.path + '.' + n)});`),
          `export default make(${JSON.stringify(a.path)});`,
        ];
        return { loader: 'js', contents: lines.join('\n') };
      });
      build.onLoad({ filter: /src[\\/]cron[\\/]service[\\/]jobs-scheduling\.ts$/ }, (a) => ({ contents: readFileSync(a.path, 'utf8') + SHIM, loader: 'ts' }));
    },
  }],
});
const oc = await import(pathToFileURL(bundlePath).href + `?t=${Date.now()}`);
const initStubCalls = beginVectors(globalThis);

const iso = (ms) => (ms === undefined || ms === null ? null : new Date(ms).toISOString());
const cronCase = (id, tz, expr, now) => {
  const schedule = { kind: 'cron', expr, tz };
  const nowMs = Date.parse(now);
  return { id, tz, expr, now: new Date(nowMs).toISOString(), next: iso(oc.computeNextRunAtMs(schedule, nowMs)), previous: iso(oc.computePreviousRunAtMs(schedule, nowMs)) };
};
const everyCase = (id, everyMs, anchor, now) => {
  const nowMs = Date.parse(now);
  const anchorMs = Date.parse(anchor);
  return { id, tz: 'UTC', everyMs, anchorMs, now: new Date(nowMs).toISOString(), next: iso(oc.computeNextRunAtMs({ kind: 'every', everyMs, anchorMs }, nowMs)), previous: null };
};

const ocVerbatim = [
  cronCase('lord-howe-repeated-half-hour', 'Australia/Lord_Howe', '* * * * * *', '2026-04-04T15:10:00Z'),
  cronCase('ny-last-valid-second-before-gap', 'America/New_York', '59 59 1,2 * * *', '2027-03-14T07:05:00Z'),
  cronCase('oslo-skips-nonexistent-reminder', 'Europe/Oslo', '30 2 * * *', '2026-03-29T00:45:00Z'),
  cronCase('ny-sun2-future-nonexistent', 'America/New_York', '30 2 * 3 SUN#2', '2026-01-01T00:00:00Z'),
  cronCase('year-limited-nonexistent', 'America/New_York', '0 30 2 14 3 * 2027', '2026-07-01T00:00:00Z'),
  cronCase('year-limited-repeated-hour', 'America/New_York', '0 30 1 1 11 * 2026', '2026-11-01T06:15:00Z'),
  cronCase('retry-rejects-real-gap-a', 'America/New_York', '30 2 * * *', '2027-03-14T06:45:00Z'),
  cronCase('retry-rejects-real-gap-b', 'America/New_York', '30 2 * * *', '2027-03-13T23:45:00Z'),
];

const fixedInstant = [
  cronCase('london-0130-before-spring', 'Europe/London', '30 1 * * *', '2026-03-28T12:00:00Z'),
  cronCase('london-0130-in-spring-gap-day', 'Europe/London', '30 1 * * *', '2026-03-29T00:15:00Z'),
  cronCase('london-0130-before-fall', 'Europe/London', '30 1 * * *', '2026-10-24T12:00:00Z'),
  cronCase('london-0130-in-fall-repeat', 'Europe/London', '30 1 * * *', '2026-10-25T00:45:00Z'),
  cronCase('ny-0230-before-spring', 'America/New_York', '30 2 * * *', '2026-03-07T12:00:00Z'),
  cronCase('ny-0230-on-spring-gap-day', 'America/New_York', '30 2 * * *', '2026-03-08T06:00:00Z'),
  cronCase('ny-0130-before-fall', 'America/New_York', '30 1 * * *', '2026-10-31T12:00:00Z'),
  cronCase('ny-0130-in-fall-repeat', 'America/New_York', '30 1 * * *', '2026-11-01T05:45:00Z'),
  cronCase('shanghai-0230-control', 'Asia/Shanghai', '30 2 * * *', '2026-03-07T12:00:00Z'),
  cronCase('shanghai-0230-control-fall', 'Asia/Shanghai', '30 2 * * *', '2026-11-01T05:45:00Z'),
  everyCase('every-1h-across-london-spring', 3_600_000, '2026-03-28T23:00:00Z', '2026-03-29T00:30:00Z'),
  everyCase('every-90m-across-ny-fall', 5_400_000, '2026-11-01T00:00:00Z', '2026-11-01T06:10:00Z'),
];

const job = (id, expr, tz, staggerMs) => ({ id, schedule: { kind: 'cron', expr, tz, ...(staggerMs === undefined ? {} : { staggerMs }) }, state: {} });
const effCase = (id, j, now) => {
  const nowMs = Date.parse(now);
  return {
    id, jobId: j.id, expr: j.schedule.expr, tz: j.schedule.tz, staggerMs: oc.resolveCronStaggerMs(j.schedule),
    now: new Date(nowMs).toISOString(), next: iso(oc.computeStaggeredCronNextRunAtMs(j, nowMs)),
    previousInclusive: iso(oc.computeStaggeredCronPreviousRunAtOrBeforeMs(j, nowMs)),
  };
};
const hourly = job('j7f3k2q', '0 * * * *', 'UTC');
const stagger = {
  offsets: [['j7f3k2q', 300000], ['j2abc9z', 300000], ['jzzzzzz', 1000], ['j7f3k2q', 1]].map(([jobId, staggerMs]) => {
    const digest = createHash('sha256').update(jobId, 'utf8').digest();
    return { jobId, staggerMs, offsetMs: oc.resolveStableCronOffsetMs(jobId, staggerMs), wholeDigestModulo: (BigInt('0x' + digest.toString('hex')) % BigInt(staggerMs)).toString() };
  }),
  defaults: ['0 * * * *', '0 0 * * * *', '0 */2 * * *', '0 9-17 * * *', '0 9 * * *', '30 * * * *', '0 0 9 * * *', '15 0 * * * *', '0 1,13 * * *', '0 *,3 * * *']
    .map((expr) => ({ expr, resolvedStaggerMs: oc.resolveDefaultCronStaggerMs(expr) ?? 0 })),
  effective: [
    effCase('before-boundary', hourly, '2026-10-13T10:04:13.352Z'),
    effCase('at-boundary', hourly, '2026-10-13T10:04:13.353Z'),
    effCase('after-boundary', hourly, '2026-10-13T10:04:13.354Z'),
    effCase('restart-after-boundary', hourly, '2026-10-13T10:30:00.000Z'),
    effCase('exact', job('j7f3k2q', '0 * * * *', 'UTC', 0), '2026-10-13T09:30:00.000Z'),
    effCase('dst-offset-london-spring', job('j7f3k2q', '0 * * * *', 'Europe/London'), '2026-03-29T00:30:00.000Z'),
    effCase('dst-offset-ny-fall', job('j7f3k2q', '0 * * * *', 'America/New_York'), '2026-11-01T05:30:00.000Z'),
    effCase('activation-inside-offset-window', hourly, '2026-10-13T10:02:00.000Z'),
  ],
};

const stubCallsDuringVectors = assertPureVectors(globalThis);
const golden = {
  generator: 'scripts/goldens/gen-oc-schedule.mjs',
  source: { repo: 'openclaw/openclaw', commit: pins.OC, files: sources },
  croner: cronerVersion,
  runtime: { node: process.version, tz: process.versions.tz ?? null, icu: process.versions.icu ?? null },
  method: 'OC sources bundled unmodified by esbuild (export statement appended to jobs-scheduling.ts); @openclaw/normalization-core resolved to the pinned workspace sources; croner from the exact devDependency',
  stubbedHostImports: [...stubbed].sort(), stubCallsDuringModuleInit: initStubCalls.length, stubCallsDuringVectors,
  ocVerbatim, fixedInstant, stagger,
};
const text = JSON.stringify(golden, null, 2) + '\n';
const digest = `${sha256(Buffer.from(text, 'utf8'))}  schedule.json\n`;
rmSync(bundlePath, { force: true });
rmSync(entry, { force: true });
if (CHECK) {
  const cur = readFileSync(join(OUT, 'schedule.json'), 'utf8');
  const sum = readFileSync(join(OUT, 'schedule.json.sha256'), 'utf8');
  if (sum !== `${sha256(Buffer.from(cur, 'utf8'))}  schedule.json\n`) fail('committed schedule.json does not match its sha256 file');
  if (cur !== text) {
    // Values must match exactly; only the recorded runtime (Node/ICU/tzdata) may differ between hosts.
    const recorded = JSON.parse(cur);
    const sameValues = JSON.stringify({ ...recorded, runtime: null }) === JSON.stringify({ ...golden, runtime: null });
    if (!sameValues) fail(`schedule.json values differ when regenerated (recorded runtime ${JSON.stringify(recorded.runtime)}, current ${JSON.stringify(golden.runtime)})`);
    console.log(`gen-oc-schedule --check: values reproduced on a different runtime (recorded ${JSON.stringify(recorded.runtime)}, current ${JSON.stringify(golden.runtime)})`);
  } else {
    console.log(`gen-oc-schedule --check: schedule.json reproduced byte-for-byte (${digest.split(' ')[0]})`);
  }
} else {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'schedule.json'), text);
  writeFileSync(join(OUT, 'schedule.json.sha256'), digest);
  console.log(`gen-oc-schedule: wrote test/goldens/oc/schedule.json ${digest.split(' ')[0]}`);
}
