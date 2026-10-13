import { describe, expect, it } from 'vitest';
import { isSdkJsonlParseError, summarizeAgentError } from '../agent-errors.js';

describe('agent error redaction', () => {
  it.each(['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'])('preserves safe syscall code %s without payloads', (code) => {
    expect(summarizeAgentError(Object.assign(new Error('SYNTHETIC_PRIVATE_OUTPUT'), { code })))
      .toBe(`Error: agent operation failed (${code})`);
  });
  it('retains builtin error class without trusting mutable name/code fields', () => {
    expect(summarizeAgentError(new TypeError('private output'))).toContain('TypeError:');
    const error = Object.assign(new Error('private'), { name: 'SYNTHETIC_SECRET', code: 'SYNTHETIC_SECRET' });
    expect(summarizeAgentError(error)).toBe('Error: agent operation failed (details withheld)');
  });
  it('reports a known bootstrap failure with safe recovery instructions', () => {
    expect(summarizeAgentError(new Error('CODEX_JSONL_PROXY_BOOTSTRAP_FAILURE: synthetic'))).toContain('reinstall dependencies');
    expect(summarizeAgentError(new Error('Codex Exec exited with code 1: CODEX_JSONL_PROXY_BOOTSTRAP_FAILURE: synthetic'))).toBe('Codex process exited with code 1');
  });
  it('recognizes actual SDK parse errors without echoing their payload or cause', () => {
    const error = new Error('Failed to parse item: SYNTHETIC_PRIVATE_PAYLOAD', {
      cause: new SyntaxError('Unterminated string in JSON at position 12'),
    });
    expect(isSdkJsonlParseError(error)).toBe(true);
    expect(summarizeAgentError(error)).toBe('Codex SDK JSONL parse failure (incomplete-json)');
    expect(summarizeAgentError(error)).not.toContain('SYNTHETIC');
  });
  it('does not classify message-text lookalikes as parser failures', () => {
    expect(isSdkJsonlParseError(new Error('Failed to parse item: claimed error'))).toBe(false);
    expect(isSdkJsonlParseError(new Error('Failed to parse item: claimed error', { cause: new Error('bad') }))).toBe(false);
  });
  it.each([new Error('secret token and tool output'), 'secret output',
    new Error('Codex Exec exited with code 1: SYNTHETIC_SECRET'),
    new Error('Codex Exec exited with signal SIGTERM: SYNTHETIC_SECRET')])('never includes arbitrary error details', (error) => {
    expect(summarizeAgentError(error)).not.toMatch(/secret|SYNTHETIC/i);
  });
});
