import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { normalizeOwnerUid } from '../owner-identity.js';
import { assembleUserMessage } from '../file-inline-wrap.js';

describe('sender review regression guards', () => {
  it('handles long nonmatching BOM runs without ambiguous separator backtracking', () => {
    const source = readFileSync(new URL('../prompt-safety.ts', import.meta.url), 'utf8');
    const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
    const probe = compiled + '\nfor(const length of [40,400,4000]){const text="\\ufeff".repeat(length)+"ordinary text";if(sanitizePromptBody(text)!==text)throw Error("content changed");}console.log("ok");';
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { timeout: 5000, encoding: 'utf8' }).trim()).toBe('ok');
  }, 10000);
  it.each(['s1_alice', 's123_alice', 's456_alice', 's1_s2_alice'])('never strips opaque UID %s', (uid) => {
    expect(normalizeOwnerUid(uid)).toBe(uid);
  });
  it('pins the space byte following the history truncation notice', () => {
    const prompt = assembleUserMessage('history '.repeat(2000), 'request', 300);
    expect(prompt).toContain('[… earlier context truncated] ');
    expect(prompt).not.toContain('[… earlier context truncated]\n');
  });
});
