// Usage: npm run build; node scripts/verify-permission-cli-abi.mjs /absolute/task-local/CLI-archive [exact CLI head]
// The caller prepares the exact pinned source archive. Never modifies a checkout.
import { constants, copyFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const source = process.argv[2];
if (!source || !isAbsolute(source) || existsSync(join(source, '.git'))) throw new Error('Explicit task-local CLI source archive required');
const revision = process.argv[3] ?? '14f9b53d3932c532d6424e8783bd94528e5f7fc6';
const versions = {
  '14f9b53d3932c532d6424e8783bd94528e5f7fc6': { 'internal/mcp/permission_host.go': '490004b2d39784d17e3b966203f6a4ec223eff76b5c9d0fabd10cbcd231a13e0' },
  'c683c724f1b007a5396d0f10b49cdfda47867b23': {
    'internal/mcp/permission_host.go': '794ef2eaaa17067af772660a4ee0cf64462086ed4c47bafd455f5f58c801bb3b',
    'docs/permission/contract-manifest-v4.json': 'dddff79aa3438e31b66afb74ef4cb0f88f417577c95adc55a50903cb8f99e766',
  },
};
if (!Object.hasOwn(versions, revision)) throw new Error('Explicit supported fixture source revision required');
for (const [path, hash] of Object.entries({
  'docs/permission/endpoint-abi-v1.json': 'd0b055d6070545c749a08dfb49cabbd7d6fa15758328c111c20d1d881d20c835',
  'internal/mcp/permission_relay.go': '864a57424f7076b157bbd596f88cce8f5d98245afdb546ea72ed706165d6519e',
  ...versions[revision],
})) {
  if (createHash('sha256').update(readFileSync(join(source, path))).digest('hex') !== hash) throw new Error('CLI ABI source pin mismatch');
}
const repo = fileURLToPath(new URL('../', import.meta.url));
const target = join(source, 'internal/mcp/xin2795_endpoint_consumer_test.go');
copyFileSync(join(repo, 'src/__tests__/fixtures/permission_cli_endpoint_test.go.txt'), target, constants.COPYFILE_EXCL);
try {
  const child = spawn('go', ['test', './internal/mcp', '-run', '^TestXIN2795CurrentEndpointChunkAndRelayABI$', '-count=1', '-v'], {
    cwd: source, stdio: 'inherit', env: { ...process.env, XIN2795_ENDPOINT_DIST: resolve(repo, 'dist'),
      XIN2795_ENDPOINT_CONSUMER: join(repo, 'src/__tests__/fixtures/permission-cli-consumer.mjs') },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve(code ?? 1));
  });
} finally { unlinkSync(target); }
