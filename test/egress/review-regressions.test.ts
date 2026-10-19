import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanEgress } from '../../scripts/egress-bypass-scan.mjs';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function fixture(handler: string, extension = 'ts', wrapper = '') {
  const root = mkdtempSync(join(tmpdir(), 'egress-review-'));
  roots.push(root);
  const put = (name: string, text: string) => { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), text); };
  put('package.json', '{"type":"module"}');
  put('src/octo/api.ts', "export function sendMessage(c: string, t: string) { console.log('DELIVERED', c, t); }\nexport function read() { return 1; }");
  if (wrapper) put('src/egress/wrapper.ts', wrapper);
  put(`src/handler.${extension}`, handler);
  const scan = () => scanEgress({ root, boundaryModules: ['src/octo/api.ts'], egressModules: ['src/egress/'], classification: { sendMessage: { class: 'write' }, read: { class: 'read' } } });
  return { root, scan };
}
const wrapper = `import * as api from '../octo/api.js';
export type Renamed = { [K in keyof typeof api as \`x\${K}\`]: (typeof api)[K] };
export function getBox(): Renamed { return Object.fromEntries(Object.entries(api).map(([k,v]) => ['x'+k,v])) as Renamed; }`;
describe('review capability provenance regressions', () => {
  it.each(['literal', 'dynamic', 'rest'])('EG-R1: renamed mapped %s projection delivers at runtime and must be rejected', mode => {
    const use = mode === 'literal' ? "box.xsendMessage('outside-egress', 'body');"
      : mode === 'rest' ? "const { ...rest } = box; rest.xsendMessage('outside-egress', 'body');"
        : "const key = String('xsendMessage') as keyof typeof box; if (key === 'xsendMessage') box[key]('outside-egress', 'body');";
    const { root, scan } = fixture(`import { getBox } from './egress/wrapper.js'; const box = getBox(); ${use}`, 'ts', wrapper);
    const compiler = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));
    execFileSync(process.execPath, [compiler, '--strict', '--noUncheckedIndexedAccess', '--module', 'nodenext', '--target', 'es2022', '--outDir', join(root, 'dist'), join(root, 'src/handler.ts')]);
    expect(execFileSync(process.execPath, [join(root, 'dist/handler.js')], { encoding: 'utf8' })).toContain('DELIVERED outside-egress body');
    const result = scan();
    expect(result.violations.length).toBeGreaterThan(0);
  }, 30_000);
  it('EG-R2: mapped read-only selection and unrelated same-signature function stay clean', () => {
    const { scan } = fixture("import type * as api from './octo/api.js'; type Read = { [K in 'read' as `x${K}`]: (typeof api)[K] }; declare const r: Read; r.xread(); const unrelated = { xsendMessage(c: string,t: string) { return c+t; } }; unrelated.xsendMessage('a','b');");
    expect(scan().violations).toEqual([]);
  });
  it.each(['sink', 'obj.tag', 'sink<unknown>'])('EG-R3: tagged substitution through %s cannot silently escape', tag => {
    const { scan } = fixture('import * as api from "./octo/api.js"; function sink<T>(_s: TemplateStringsArray, ..._v: T[]) {} const obj = { tag: sink }; '+tag+'`${api}`;');
    expect(scan().violations.some(v => v.code === 'unresolved-boundary-extraction')).toBe(true);
  });
  it.each(['js', 'mjs', 'cjs', 'mts', 'cts', 'tsx'])('EG-R4: %s source is scanned', ext => {
    const code = ext === 'cjs' || ext === 'cts' ? "const api = require('./octo/api.js'); api.sendMessage('c','t');" : "import { sendMessage } from './octo/api.js'; sendMessage('c','t');";
    expect(fixture(code, ext).scan().violations.length).toBeGreaterThan(0);
  });
  it('EG-R5: missing boundary and unresolved module loading fail closed', () => {
    const f = fixture('const spec = String("./octo/api.js"); void import(spec);');
    expect(f.scan().violations.some(v => v.code === 'unresolved-dynamic-import')).toBe(true);
    rmSync(join(f.root, 'src/octo/api.ts'));
    expect(f.scan().violations.some(v => v.code === 'missing-boundary-module')).toBe(true);
  });
});
