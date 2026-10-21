import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { TurnFailure, failureReply } from '../agent-failure.js';
import { recordPrivateFailure } from '../private-diagnostics.js';

let message: string;
let eventType: string;
let runs: number;
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    startThread() {
      return { runStreamed: async () => ({ events: (async function* () {
        runs++;
        if (eventType === 'exception') throw new Error(message);
        if (eventType.startsWith('item.')) yield { type: eventType, item: { id: 'failure', type: 'error', message } };
        else if (eventType === 'turn.failed') yield { type: eventType, error: { message } };
        else yield { type: eventType, message };
      })() }) };
    }
  },
}));
import { queryAgentEvents } from '../agent-bridge.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'diagnostic-no-text-')); runs = 0; });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('metadata-only diagnostics persist no arbitrary error text', () => {
  const messages = [
    'failure authorization:Bearer SYNTHETIC_CREDENTIAL',
    'failure authorization:Basic SYNTHETIC_CREDENTIAL',
    'failure authorization: Bearer SYNTHETIC_CREDENTIAL',
    'failure authorization: Basic SYNTHETIC_CREDENTIAL',
    'failure cookie:sid=SYNTHETIC_FIRST; session=SYNTHETIC_SECOND',
    'failure cookie: sid=SYNTHETIC_FIRST; session=SYNTHETIC_SECOND',
    'unmarked SYNTHETIC_PRIVATE_CONTENT',
  ];
  for (const type of ['item.started', 'item.updated', 'item.completed', 'turn.failed', 'error', 'exception']) {
    it.each(messages)(`${type}: fingerprints but never writes %s`, async input => {
      message = input; eventType = type;
      const config = {
        botToken: 'synthetic', apiUrl: 'https://example.com', baseDir: root,
        cwd: join(root, 'workspace'), cwdBase: join(root, 'workspace'), dataDir: root,
        cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' },
        // A legacy extra key must not reactivate the removed capture path.
        sdk: { privateDiagnostics: true, privateDiagnosticsDetails: true, privateDiagnosticsText: true,
          recovery: { enabled: true } },
        rateLimit: { maxPerMinute: 5 }, context: { maxContextChars: 6000, historyLimit: 40 },
        maxResponseChars: 524288, dispatchTimeoutMs: 300000,
      } as Config;
      let caught: unknown;
      try {
        for await (const event of queryAgentEvents('synthetic request', config, undefined, undefined,
          { diagnosticId: '3f8d62cf-fca8-4e92-a0a0-cdb5db5c6ab2' })) void event;
      } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(TurnFailure);
      const error = caught as TurnFailure;
      expect(error.report).toMatchObject({ attempts: 1, final: { category: 'unknown' } });
      expect(runs).toBe(1);
      expect(recordPrivateFailure(root, true, error.report, error)).toBe(true);
      const encoded = readFileSync(join(root, 'diagnostics/agent-failures.jsonl'), 'utf8');
      const row = JSON.parse(encoded);
      expect(row.sdk).not.toHaveProperty('text');
      expect(row.sdk).toMatchObject({ fingerprint: createHash('sha256').update(input).digest('hex'),
        messageBytes: Buffer.byteLength(input), detail: { eventSubtype: type } });
      expect(encoded).not.toContain(input);
      expect(encoded).not.toContain('SYNTHETIC_');
      expect(JSON.stringify(error)).not.toContain('SYNTHETIC_');
      expect(failureReply(error.report)).not.toContain('SYNTHETIC_');
    });
  }
});
