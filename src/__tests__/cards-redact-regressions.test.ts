import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reduceItem, hasSecretShape, sanitizeText } from '../cards/redact.js';
import corpus from '../cards/__fixtures__/privacy-corpus.v2.json' with { type: 'json' };

// The deadline lives in the parent process. It can interrupt a blocked reducer.
// Transpile the real source in the child so the test needs no production build.
const childSource = String.raw`
import fs from 'node:fs';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';
const sourcePath = process.argv[1];
const mode = process.argv[2];
const corpus = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
let source = fs.readFileSync(sourcePath, 'utf8');
if (mode === 'vendor-negative') {
  source = source.replaceAll('[A-Za-z0-9_-]{8,}/i.test(', '[A-Za-z0-9_-]{8,}/.test(');
}
source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(sourcePath).href));
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { reduceItem } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
if (mode === 'lexer-negative') {
  // Exact nested-repeat expression from the rejected reducer. The parent must kill it.
  /^(?:[^\s'"\x60]+|'[^']*'|"[^"]*")+(?=\s|$)/.exec('a'.repeat(28) + "'");
  process.stdout.write(JSON.stringify({ completed: true }));
} else if (mode === 'vendor-negative') {
  const passed = corpus.urlCases.every(c => reduceItem({type:'web_search',url:c.url}).domain === c.expected);
  process.stdout.write(JSON.stringify({ passed }));
} else {
  let passed = true;
  for (const c of corpus.commandCases) {
    const facts = reduceItem({type:'command_execution', command:c.command});
    if (facts.program !== c.expected || Object.keys(facts).sort().join(',') !== 'category,exitClass,program') passed = false;
  }
  const scaling = [];
  for (const size of [64, 1024, 4096, 8192]) {
    const command = 'A="' + 'a'.repeat(size - 10) + '" git x';
    const start = performance.now();
    for (let i = 0; i < 100; i++) reduceItem({type:'command_execution',command});
    scaling.push({size, iterations:100, milliseconds:performance.now()-start});
  }
  process.stdout.write(JSON.stringify({ passed, scaling }));
}
`;
interface ChildReceipt {
  readonly timedOut: boolean;
  readonly exit: number | null;
  readonly output: string;
}
function isolated(mode: string, deadline = 3000): Promise<ChildReceipt> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource,
      fileURLToPath(new URL('../cards/redact.ts', import.meta.url)), mode,
      fileURLToPath(new URL('../cards/__fixtures__/privacy-corpus.v2.json', import.meta.url))],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', () => { /* Never echo child source or machine paths. */ });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, deadline);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', exit => { clearTimeout(timer); resolve({ timedOut, exit, output }); });
  });
}

describe('WP-05 correction R1 canonicalization-safe vendor corpus v2', () => {
  for (const prefix of corpus.vendorPrefixes) it('standalone transformations '+prefix, () => {
    const token = prefix + 'exampleaa';
    for (const text of [token, token.toLowerCase(), token.toUpperCase(),
      token.replace(/./g, (c, i) => i % 2 ? c.toUpperCase() : c.toLowerCase()),
      token.slice(0, 2) + '\u202e' + token.slice(2)]) {
      expect(hasSecretShape(text)).toBe(true);
      expect(sanitizeText(text, 'text')).toBe('text');
    }
  });
  for (const c of corpus.urlCases) it(c.id, () => {
    const facts = reduceItem({type:'web_search',url:c.url});
    expect(facts.domain === c.expected).toBe(true);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(reduceItem({type:'web_search',url:c.url})).toEqual(facts);
  });
  it('negative control rejects the pre-correction case-sensitive vendor detector', async () => {
    const receipt = await isolated('vendor-negative');
    expect(receipt.timedOut).toBe(false);
    expect(receipt.exit).toBe(0);
    expect(JSON.parse(receipt.output).passed).toBe(false);
  });
});

describe('WP-05 correction R2 bounded command parsing', () => {
  it('finishes adversarial/quoted/boundary corpus in an externally bounded child, with scaling receipts', async () => {
    const receipt = await isolated('candidate');
    expect(receipt.timedOut).toBe(false);
    expect(receipt.exit).toBe(0);
    const result = JSON.parse(receipt.output) as { passed: boolean; scaling: {size:number;iterations:number;milliseconds:number}[] };
    expect(result.passed).toBe(true);
    expect(result.scaling.map(r => r.size)).toEqual([64, 1024, 4096, 8192]);
    // Diagnostic timings only: the hard parent deadline is the performance oracle.
    console.log('R2 scaling receipt', JSON.stringify(result.scaling));
  });
  it('negative control kills the rejected nested-repeat lexer using the same external deadline', async () => {
    const receipt = await isolated('lexer-negative');
    expect(receipt.timedOut).toBe(true);
    expect(receipt.exit).toBeNull();
    expect(receipt.output).toBe('');
  });
});
