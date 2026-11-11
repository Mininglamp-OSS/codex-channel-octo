import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';

const run = promisify(execFile);
const fixtures = fileURLToPath(new URL('./fixtures/pinned-transport/', import.meta.url));
let compiled: string;
// Compile the real module graph for a fresh child process (real builtin DNS/TLS
// and NODE_EXTRA_CA_CERTS). No global fetch or production transport mocks.
beforeAll(() => {
  compiled = mkdtempSync(join(tmpdir(), 'cco-pinned-'));
  writeFileSync(join(compiled, 'package.json'), '{"type":"module"}');
  symlinkSync(resolve('node_modules'), join(compiled, 'node_modules'), 'dir');
  const visited = new Set<string>();
  function compile(relative: string): void {
    if (visited.has(relative)) return; visited.add(relative);
    const source = readFileSync(resolve('src', relative.replace(/\.js$/, '.ts')), 'utf8');
    const output = join(compiled, relative); mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText);
    for (const match of source.matchAll(/(?:from\s+|import\s*\()['"](\.[^'"]+\.js)['"]/g)) {
      compile(join(dirname(relative), match[1]));
    }
  }
  compile('octo/media.js'); compile('url-policy.js');
});
afterAll(() => rmSync(compiled, { recursive: true, force: true }));
async function probe(scenario: string) {
  const { stdout } = await run(process.execPath, [join(fixtures, 'probe.mjs'), compiled, scenario, join(fixtures, 'cert.pem'), join(fixtures, 'key.pem')], {
    timeout: 10000, env: { ...process.env, NODE_EXTRA_CA_CERTS: join(fixtures, 'cert.pem') },
  });
  return JSON.parse(stdout.trim());
}
describe('F-PR96-P2-PRESIGN-REBINDING: real TLS and HTTP effects', () => {
  it.each(['rebind', 'aaaa', 'mapped', 'fallback'])('pins %s to approved answers while preserving URL/TLS identity and exact PUT', async scenario => {
    const result = await probe(scenario);
    expect(result.outcome).toBe('success');
    expect(result.counts).toMatchObject({ presign: 1, publicPut: 1, privatePut: 0, send: 1 });
    expect(result.targets).not.toContain('127.0.0.1');
    expect(result.bodies).toEqual(['000102feff']);
    expect(result.headers[0]['content-type']).toBe('ImAgE/PnG');
    expect(result.headers[0].authorization).toBeUndefined();
    expect(result.identities[0]).toMatchObject({ sni: 'rebind.test' });
    expect(result.identities[0].host).toMatch(/^rebind\.test:/);
  });
  it.each(['private', 'mixed', 'mapped-private'])('rejects %s at validation with zero PUT/send', async scenario => {
    const result = await probe(scenario);
    expect(result.outcome).toBe('presign_failed');
    expect(result.counts).toMatchObject({ presign: 1, publicPut: 0, privatePut: 0, send: 0 });
    expect(result.targets).toEqual([]);
  });
  it('still rejects a certificate for the wrong original hostname with zero PUT', async () => {
    const result = await probe('wrong-cert');
    expect(result.outcome).toBe('outcome_unknown');
    expect(result.counts).toMatchObject({ presign: 1, publicPut: 0, privatePut: 0, send: 0 });
  });
  it('does not reuse a connection or cached approval after DNS changes', async () => {
    const result = await probe('reuse');
    expect(result.outcome).toBe('success'); expect(result.second).toBe('presign_failed');
    expect(result.counts).toMatchObject({ presign: 2, publicPut: 1, privatePut: 0, send: 1 });
  });
  it('does not reuse an old public socket for a new approved address set', async () => {
    const result = await probe('reuse-public');
    expect(result.outcome).toBe('success'); expect(result.second).toBe('success');
    expect(result.counts).toMatchObject({ presign: 2, publicPut: 2, privatePut: 0, send: 1 });
    expect(result.targets).toEqual(['8.8.8.8', '8.8.4.4']);
  });
  it('keeps redirect:error for PUT without sending a second request or image message', async () => {
    const result = await probe('put-redirect');
    expect(result.outcome).toBe('outcome_unknown');
    expect(result.counts).toMatchObject({ presign: 1, publicPut: 1, privatePut: 0, send: 0 });
    expect(result.targets).toEqual(['8.8.8.8']);
  });
  it('preserves streamed gzip response decoding for shared inbound consumers', async () => {
    const result = await probe('gzip');
    expect(result.outcome).toBe('content'); expect(result.counts.get).toBe(1);
  });
  it('pins every public redirect hop', async () => {
    const result = await probe('redirect-public');
    expect(result.outcome).toBe('content'); expect(result.counts.get).toBe(2);
    expect(result.targets).toEqual(['8.8.8.8', '8.8.8.8']);
  });
  it('rejects a private redirect before its connection', async () => {
    const result = await probe('redirect-private');
    expect(result.counts.get).toBe(1); expect(result.targets).toEqual(['8.8.8.8']);
    expect(result.outcome).not.toBe('content');
  });
  it('keeps the parent abort effective after response headers', async () => {
    const result = await probe('abort');
    expect(result.outcome).toBe('AbortError'); expect(result.counts.get).toBe(1);
  });
});
