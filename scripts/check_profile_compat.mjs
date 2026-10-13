/** Compare serialized default configuration with the pinned source in a temporary HOME. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const root = mkdtempSync(join(tmpdir(), 'env02-compat-'));
try {
  const source = execFileSync('git', ['show', 'dd1298083d014d8e82376c01edb38a2e6914366f:src/config.ts'], { encoding: 'utf8' });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'baseline.mjs'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  copyFileSync('dist/url-policy.js', join(root, 'url-policy.js'));
  mkdirSync(join(root, '.codex-channel-octo'), { mode: 0o700 });
  writeFileSync(join(root, '.codex-channel-octo/config.json'), '{"apiUrl":"https://example.com"}', { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: root };
  const run = path => execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {loadConfig, DEFAULT_CONFIG_PATH, resolveBotConfigs} from ${JSON.stringify(pathToFileURL(path).href)}; console.log(JSON.stringify({path:DEFAULT_CONFIG_PATH, config:loadConfig(), bots:resolveBotConfigs(loadConfig())}));`], { env, encoding: 'utf8' });
  const before = run(join(root, 'baseline.mjs'));
  const after = run(resolve('dist/config.js'));
  if (before !== after) throw new Error('Default config compatibility mismatch');
  console.log('PASS: exported default path, merged defaults and zero-bot resolution are byte-identical to dd12980.');
} finally { rmSync(root, { recursive: true, force: true }); }
