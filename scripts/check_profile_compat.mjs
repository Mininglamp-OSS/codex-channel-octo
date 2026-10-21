/** Compare serialized default configuration with the pinned source in a temporary HOME. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
// Config.cards (WP-15) postdates the pinned baseline. Drop it only when it is
// byte-identical to the default snapshot; any other value still fails the check.
const DEFAULT_CARDS = '{"disable":false,"eventTransport":"off","reasoningSummary":"off"}';
function withoutDefaultCards(output) {
  const value = JSON.parse(output);
  const strip = config => {
    if (JSON.stringify(config.cards) !== DEFAULT_CARDS) throw new Error('Default config compatibility mismatch: cards is not the default snapshot');
    delete config.cards;
  };
  strip(value.config);
  value.bots.forEach(strip);
  return `${JSON.stringify(value)}\n`;
}
const root = mkdtempSync(join(tmpdir(), 'env02-compat-'));
try {
  const source = execFileSync('git', ['show', 'f3ca7657f82a069a4b357a6ec6cdc1295c432c05:src/config.ts'], { encoding: 'utf8' });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'baseline.mjs'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  // Config now imports recovery validation and its native-only dependency graph.
  cpSync('dist', root, { recursive: true });
  mkdirSync(join(root, '.codex-channel-octo'), { mode: 0o700 });
  writeFileSync(join(root, '.codex-channel-octo/config.json'), '{"apiUrl":"https://example.com"}', { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: root };
  const run = path => execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {loadConfig, DEFAULT_CONFIG_PATH, resolveBotConfigs} from ${JSON.stringify(pathToFileURL(path).href)}; console.log(JSON.stringify({path:DEFAULT_CONFIG_PATH, config:loadConfig(), bots:resolveBotConfigs(loadConfig())}));`], { env, encoding: 'utf8' });
  const before = run(join(root, 'baseline.mjs'));
  const after = withoutDefaultCards(run(resolve('dist/config.js')));
  if (before !== after) throw new Error('Default config compatibility mismatch');
  console.log('PASS: exported default path, merged defaults and zero-bot resolution are byte-identical to main f3ca765 (default cards snapshot excluded).');
} finally { rmSync(root, { recursive: true, force: true }); }
