// Usage: npm run build; node scripts/verify-permission-cli-abi.mjs /absolute/task-local/CLI-archive [exact CLI head]
// The caller prepares the exact pinned source archive. Never modifies a checkout.
import { constants, copyFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const source = process.argv[2];
if (!source || !isAbsolute(source) || existsSync(join(source, '.git'))) throw new Error('Explicit task-local CLI source archive required');
const revision = process.argv[3] ?? '30a8991c0bbbdfd42399e07dadbb60c74b26c3b4';
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
  '3ef52206809ade6b10fcb6976e4c7ab7c8af69a7': {
    'internal/mcp/permission_relay.go': '0c2557ec51ec18fcb03e4c35fc2b6b9f48b4d01826db60db5f66b3e1bad5f7ad',
    'internal/mcp/permission_host.go': 'f9ef0cc4ac84f7c4c712936af9fe5efe86a5fc7baeedd7bfcc011b467abf0e2b',
    'internal/mcp/managed.go': '32eed0a7fcd50d0851d8ba2671705f9c754ce280cd40e015c1b8bf01c8b34239',
    'internal/permission/coordinator.go': '6a5d7c78d76986d642c6cb2a732041a5868abbe18facb99a4dab1ca7dabf9b4e',
    'internal/permission/runtime.go': '6357de6ac114fd7a641f45f5ad9c855654b710564b5c5c0ed4f69acf5e3130d0',
    'docs/permission/endpoint-abi-v2.json': '785342476f15d3d21a9936d370117dfcf6df49aa040d04ebbb21b786453470f9',
    'docs/permission/cli-component-contract-v6.json': 'aea8d2d11c419a70069c3c26f6f2f27c98e7d865164a178a1f991160ab4b2a3e',
    'docs/permission/contract-manifest-v6.json': '37355c4f25f86b5fe438439a4cba0270ec6f0726b5254b6ab40fdb4b8db57e0d',
    'docs/permission/response-budget-ledger-v6.json': '7c46334eacc9796c003c6929373033359e0428ed57d74a07244db84a7837e463',
    'docs/permission/catalog-package-v2/manifest.json': 'ecc56c2ab0a2c520ab7e5203d2abab06671daf90c28d69f88fe1de8d154109fc',
    'docs/permission/source-slot-witness-v5.json.gz': '0c5da173bd0f53c64562a70a5c5feebc955ad111bbe84ed11f5588c08b4b9c0b',
  },
  '30a8991c0bbbdfd42399e07dadbb60c74b26c3b4': {
    'internal/mcp/permission_relay.go': '07e67533a5ed670fbf28c37a0021e81981b2912444659d66648d3f801cedb2cf',
    'internal/mcp/permission_host.go': '680b6848baf38014a0a2a837b124f5d66b744e6d3dad549bab746dd02919cb5f',
    'internal/mcp/managed.go': '24eb19958f5bbe40c601d3a9d78fe6873e993ec9992831b5d3688b4c749aadae',
    'internal/permission/coordinator.go': '6a5d7c78d76986d642c6cb2a732041a5868abbe18facb99a4dab1ca7dabf9b4e',
    'internal/permission/runtime.go': '6357de6ac114fd7a641f45f5ad9c855654b710564b5c5c0ed4f69acf5e3130d0',
    'docs/permission/endpoint-abi-v2.json': '7fc8534000d299fd3e03e85f9c22ba7b5a5f699e4009ee00b27ee10c19dbcb32',
    'docs/permission/cli-component-contract-v6.json': '1b840f6b2bb97f3a06a83754de0b506dffc0a64174d7c24b9212ceaf139e9409',
    'docs/permission/contract-manifest-v6.json': 'e8f916b7f0b7551691b4359e0643bcbe9e6f51b0d10763232dd6b11805ce8d38',
    'docs/permission/response-budget-ledger-v6.json': '7c46334eacc9796c003c6929373033359e0428ed57d74a07244db84a7837e463',
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
