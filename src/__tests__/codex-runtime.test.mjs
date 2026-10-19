import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCodexRuntime } from '../../scripts/check-codex-runtime.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture({ expected = '0.163.0', cli = expected, binary = cli, body } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-version-contract-')); roots.push(root);
  const sdk = join(root, 'node_modules/@openai/codex-sdk');
  mkdirSync(join(sdk, 'dist'), { recursive: true });
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@openai/codex-sdk', version: '0.163.0', dependencies: { '@openai/codex': expected } }));
  const sdkEntry = join(sdk, 'dist/index.js'); writeFileSync(sdkEntry, '');
  const cliRoot = join(sdk, 'node_modules/@openai/codex'); mkdirSync(join(cliRoot, 'bin'), { recursive: true });
  writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: cli }));
  writeFileSync(join(cliRoot, 'bin/codex.js'), body ?? `process.stdout.write(${JSON.stringify('codex-cli ' + binary + '\n')});`);
  return { root, sdkEntry };
}
describe('SDK-associated runtime version verification', () => {
  it.skipIf(process.platform === 'win32')('runs the public checker through a symlink instead of silently exiting', () => {
    const { root } = fixture();
    const link = join(root, 'runtime-check.mjs');
    symlinkSync(fileURLToPath(new URL('../../scripts/check-codex-runtime.mjs', import.meta.url)), link);
    const result = spawnSync(process.execPath, [link], { encoding: 'utf8', timeout: 15000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({sdk:expect.any(String),cli:expect.any(String),nativeCli:expect.any(String)});
  });
  it('checks the native executable under the SDK, ignoring an unrelated outer CLI', () => {
    const { root, sdkEntry } = fixture();
    const decoy = join(root, 'node_modules/@openai/codex/bin'); mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, 'codex.js'), 'throw Error("WRONG_CLI");');
    expect(checkCodexRuntime({ sdkEntry })).toEqual({ sdk: '0.163.0', cli: '0.163.0', nativeCli: '0.163.0' });
  });
  it('uses the CLI version declared by SDK rather than assuming their versions are identical', () => {
    expect(checkCodexRuntime(fixture({ expected: '0.162.1' }))).toEqual({ sdk: '0.163.0', cli: '0.162.1', nativeCli: '0.162.1' });
  });
  it('rejects a dependency version mismatch before launching it', () => {
    expect(() => checkCodexRuntime(fixture({ cli: '0.142.3', body: 'throw Error("MUST_NOT_LAUNCH");' }))).toThrow('CODEX_RUNTIME_DEPENDENCY_MISMATCH');
  });
  it('rejects a different native binary behind a correctly versioned CLI package', () => {
    expect(() => checkCodexRuntime(fixture({ binary: '0.142.3' }))).toThrow('CODEX_RUNTIME_NATIVE_VERSION_MISMATCH');
  });
  it('reports startup failure without exposing subprocess stderr', () => {
    expect(() => checkCodexRuntime(fixture({ body: 'process.stderr.write("PRIVATE_STDERR"); process.exit(2);' }))).toThrow(/^CODEX_RUNTIME_NATIVE_START_FAILED$/);
  });
  it('fails clearly when the SDK-associated CLI is missing', () => {
    const { root, sdkEntry } = fixture(); rmSync(join(root, 'node_modules/@openai/codex-sdk/node_modules'), { recursive: true });
    expect(() => checkCodexRuntime({ sdkEntry })).toThrow('CODEX_RUNTIME_CLI_UNAVAILABLE');
  });
  it.each(['latest', '^0.163.0', '0.164.0-alpha.1'])('refuses an unverified SDK CLI dependency contract %s', expected => {
    expect(() => checkCodexRuntime(fixture({ expected }))).toThrow('CODEX_RUNTIME_UNSUPPORTED_SDK_CONTRACT');
  });
});
