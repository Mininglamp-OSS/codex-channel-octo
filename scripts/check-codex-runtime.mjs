import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

function manifestFor(entry, name) {
  let dir = dirname(entry);
  // Resolve from a known package entry, never from operator configuration.
  for (let depth = 0; depth < 8; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (manifest.name === name) return manifest;
    } catch { /* An intermediate dist directory need not contain a manifest. */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('CODEX_RUNTIME_MANIFEST_UNAVAILABLE');
}

/** Resolve exactly the SDK-associated CLI used by the gateway, not PATH codex.
 * No authentication, inference requests or operator configuration are needed. */
export function checkCodexRuntime({ sdkEntry = fileURLToPath(import.meta.resolve('@openai/codex-sdk')) } = {}) {
  const sdk = manifestFor(sdkEntry, '@openai/codex-sdk');
  const expected = sdk.dependencies?.['@openai/codex'];
  const stable = /^\d+\.\d+\.\d+$/;
  if (!stable.test(sdk.version) || typeof expected !== 'string' || !stable.test(expected)) {
    throw new Error('CODEX_RUNTIME_UNSUPPORTED_SDK_CONTRACT');
  }
  let cliEntry;
  try { cliEntry = createRequire(sdkEntry).resolve('@openai/codex/bin/codex.js'); }
  catch { throw new Error('CODEX_RUNTIME_CLI_UNAVAILABLE'); }
  const cli = manifestFor(cliEntry, '@openai/codex');
  if (cli.version !== expected) throw new Error('CODEX_RUNTIME_DEPENDENCY_MISMATCH');
  const native = spawnSync(process.execPath, [cliEntry, '--version'], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 4096,
  });
  // Never print arbitrary subprocess output, stderr, paths or environment.
  if (native.error || native.status !== 0 || native.signal) throw new Error('CODEX_RUNTIME_NATIVE_START_FAILED');
  const match = /^codex-cli (\d+\.\d+\.\d+)\r?\n?$/.exec(native.stdout);
  if (!match || match[1] !== expected) throw new Error('CODEX_RUNTIME_NATIVE_VERSION_MISMATCH');
  return { sdk: sdk.version, cli: cli.version, nativeCli: match[1] };
}

// Node canonicalizes the entry URL, while argv may retain a symlink or macOS
// /var alias. Canonicalize argv too, otherwise direct execution can be a no-op.
let isMain = false;
try { isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
catch { /* Imported module or unavailable argv entry. */ }
if (isMain) {
  try { console.log(JSON.stringify(checkCodexRuntime())); }
  catch (error) {
    const code = error instanceof Error && /^CODEX_RUNTIME_[A-Z_]+$/.test(error.message)
      ? error.message : 'CODEX_RUNTIME_CHECK_FAILED';
    console.error(`${code}: verify SDK dependencies and platform CLI installation; global codex is not used.`);
    process.exitCode = 1;
  }
}
