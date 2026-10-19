/**
 * T26 — prompt framing snapshot. The strings passed to `runStreamed` for the
 * initial, stream-recovery and stale-resume fresh-retry attempts must stay
 * stable with the merged sender/document/private-memory security prefix. The
 * digests include private-memory background guidance even when no snapshot is
 * supplied; any edit to the shared framing changes them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

type Ev = Record<string, unknown>;
let scriptedRuns: Array<() => AsyncGenerator<Ev>>;
let runIdx: number;
const prompts: string[] = [];

function makeThread() {
  return {
    async runStreamed(prompt: string) {
      prompts.push(prompt);
      const gen = scriptedRuns[runIdx++];
      if (!gen) throw new Error('no scripted run left');
      return { events: gen() };
    },
  };
}

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    startThread() {
      return makeThread();
    }
    resumeThread() {
      return makeThread();
    }
  },
}));

import { queryAgent } from '../agent-bridge.js';
import type { Config } from '../config.js';

function cfg(): Config {
  return {
    botToken: 't',
    apiUrl: 'https://example.com',
    baseDir: '/tmp/cco-test',
    cwd: '/tmp/cco-test/ws',
    cwdBase: '/tmp/cco-test/ws',
    dataDir: '/tmp/cco-test/data',
    sdk: {},
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524288,
    dispatchTimeoutMs: 300000,
  } as Config;
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const interrupt = 'stream disconnected before completion: stream closed before response.completed';

beforeEach(() => {
  runIdx = 0;
  scriptedRuns = [];
  prompts.length = 0;
});

async function drain(opts?: Parameters<typeof queryAgent>[4]): Promise<void> {
  for await (const t of queryAgent('USER BODY', cfg(), undefined, undefined, opts)) void t;
}

describe('T26: framing keeps sender and private-memory guidance on a successful run', () => {
 it('keeps the sender block and current-message anchor in the initial prompt',async()=>{
  scriptedRuns=[async function*(){yield {type:'turn.completed',usage:{}};}];
  await drain();expect(prompts).toHaveLength(1);
  expect(prompts[0].endsWith('\n\n---\n\n[Current message — respond to this ONLY]\nUSER BODY')).toBe(true);
  expect(sha(prompts[0])).toBe('fffa3e75f14799f20c9bf99926b293bd0371dbee62fea0455f5dcee986233f34');
 });
 it('never emits fallback or continuation prompts when execution is uncertain',async()=>{
  scriptedRuns=[async function*(){throw new Error(interrupt);}];
  await expect(drain({resume:'old'})).rejects.toThrow();
  expect(prompts).toHaveLength(1);expect(prompts[0]).not.toContain('FALLBACK BODY');
 });
});
