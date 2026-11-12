// Usage: npm run build; node scripts/verify-permission-cli-abi.mjs /absolute/task-local/CLI-archive [exact CLI head]
// The caller prepares the exact pinned source archive. Never modifies a checkout.
import { constants, copyFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const source = process.argv[2];
if (!source || !isAbsolute(source) || existsSync(join(source, '.git'))) throw new Error('Explicit task-local CLI source archive required');
const revision = process.argv[3] ?? '29d81e09dc544b9928d94a9123736330d5d0174f';
const versions = {
  '14f9b53d3932c532d6424e8783bd94528e5f7fc6': {
    'internal/mcp/permission_relay.go': '864a57424f7076b157bbd596f88cce8f5d98245afdb546ea72ed706165d6519e',
    'internal/mcp/permission_host.go': '490004b2d39784d17e3b966203f6a4ec223eff76b5c9d0fabd10cbcd231a13e0',
  },
  'c683c724f1b007a5396d0f10b49cdfda47867b23': {
    'internal/mcp/permission_relay.go': '864a57424f7076b157bbd596f88cce8f5d98245afdb546ea72ed706165d6519e',
    'internal/mcp/permission_host.go': '794ef2eaaa17067af772660a4ee0cf64462086ed4c47bafd455f5f58c801bb3b',
    'docs/permission/contract-manifest-v4.json': 'dddff79aa3438e31b66afb74ef4cb0f88f417577c95adc55a50903cb8f99e766',
  },
  '27b387f1b767a6e0cc200b8e23d074ad3bd28cc1': {
    'internal/mcp/permission_relay.go': 'b7799d7d97fbfe579fa43ccde05612e0d313471ba4b07cd237b51bca7a08795a',
    'internal/mcp/permission_host.go': '794ef2eaaa17067af772660a4ee0cf64462086ed4c47bafd455f5f58c801bb3b',
    'docs/permission/contract-manifest-v5.json': 'd54a11eac89263c9a5ddd3279af03c750ccc1775d2832cbe647eab9d089b411a',
    'docs/permission/catalog-package-v2/manifest.json': 'ecc56c2ab0a2c520ab7e5203d2abab06671daf90c28d69f88fe1de8d154109fc',
    'docs/permission/source-slot-witness-v5.json.gz': '0c5da173bd0f53c64562a70a5c5feebc955ad111bbe84ed11f5588c08b4b9c0b',
  },
  'd39072f8182a28ce2be5884151eb03f16cd205b2': {
    'internal/mcp/permission_relay.go': '1856c7c3bf92490fed33459fe4da3e2c9b6b9d7690a6fbb088f72acd285be7bb',
    'internal/mcp/permission_host.go': 'b6cf97112fdaa79e86dfa2bd90439b0fbb60bb6dbda1597623e795271bfc055b',
    'docs/permission/endpoint-abi-v2.json': '7f9556d0526cff30ef1c36d53d2457dbc4266b8912722717badebac796ad8909',
    'docs/permission/cli-component-contract-v6.json': '8da203c9e6b650f5bc94d81080f4ed7281bd2cc36755ff0027f8e2e6b0b9fe9d',
    'docs/permission/contract-manifest-v6.json': '7fbb9cece9dfa384181c2fc272cb6afc7f6667b32712aa2e71c8a1c04615301d',
    'docs/permission/catalog-package-v2/manifest.json': 'ecc56c2ab0a2c520ab7e5203d2abab06671daf90c28d69f88fe1de8d154109fc',
    'docs/permission/source-slot-witness-v5.json.gz': '0c5da173bd0f53c64562a70a5c5feebc955ad111bbe84ed11f5588c08b4b9c0b',
  },
  '29d81e09dc544b9928d94a9123736330d5d0174f': {
    'internal/mcp/permission_relay.go': '7200b0f8e2d0ef6e158e71bfdd361707cfc97b30f4d80403ee8074520204ec5c',
    'internal/mcp/permission_host.go': '48cbb855df1a90835f90115008eb408bf7af8d59683329c4e7f4d132e5142ba1',
    'docs/permission/endpoint-abi-v2.json': '219f927f2522ac5090ef257d50ca5bf5768055607df028ca6c7ad04de1223cdf',
    'docs/permission/cli-component-contract-v6.json': '16e924573297469c56c0346b8b6b023f06a68d5ed2f2e389de2ea1664326b4d5',
    'docs/permission/contract-manifest-v6.json': 'be8e31a1f19ab4314390fe7767c58a4fbbcf024cb5c76cb13e3fcac15120d83e',
    'docs/permission/response-budget-ledger-v6.json': 'b7c646f4c73fe62d00450a5fec10d4a0f852f227b1040c8b3c31cf94475c9263',
    'docs/permission/catalog-package-v2/manifest.json': 'ecc56c2ab0a2c520ab7e5203d2abab06671daf90c28d69f88fe1de8d154109fc',
    'docs/permission/source-slot-witness-v5.json.gz': '0c5da173bd0f53c64562a70a5c5feebc955ad111bbe84ed11f5588c08b4b9c0b',
  },
};
if (!Object.hasOwn(versions, revision)) throw new Error('Explicit supported fixture source revision required');
for (const [path, hash] of Object.entries({
  'docs/permission/endpoint-abi-v1.json': 'd0b055d6070545c749a08dfb49cabbd7d6fa15758328c111c20d1d881d20c835',
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
