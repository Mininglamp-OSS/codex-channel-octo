import { describe, expect, it } from 'vitest';
import { assertLoopbackOnly } from '../real-binary/harness.js';

// Captured from binary 0.142.3 in the Linux CI stderr, not a network request.
const prerequisiteDiagnostic = 'Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.';

describe('loopback evidence guard', () => {
  it('NET-01: the exact pinned sandbox prerequisite diagnostic is an offline reference', () => {
    expect(() => assertLoopbackOnly(prerequisiteDiagnostic, 'captured-linux-stderr')).not.toThrow();
  });
  it('NET-02: the documentation host is still rejected outside that diagnostic', () => {
    expect(() => assertLoopbackOnly('connection failed: https://developers.openai.com/codex/concepts/sandboxing#prerequisites', 'stderr')).toThrow(/network escape/);
  });
  it('NET-03: provider, WebSocket and curated-plugin endpoints are rejected', () => {
    for (const url of ['https://api.openai.com/v1/responses', 'wss://api.openai.com/v1/responses', 'https://github.com/openai/plugins.git/']) {
      expect(() => assertLoopbackOnly(`connection failed: ${url}`, 'stderr'), url).toThrow(/network escape/);
    }
  });
  it('NET-04: lookalike loopback names and non-loopback IP addresses are rejected', () => {
    for (const url of ['http://localhost.example.com', 'http://127.0.0.1.example.com', 'http://10.0.0.2:8080', 'http://[fd00::1]:8080']) {
      expect(() => assertLoopbackOnly(`connection failed: ${url}`, 'stderr'), url).toThrow(/network escape/);
    }
  });
  it('NET-05: exact IPv4, hostname and IPv6 loopback addresses are permitted', () => {
    for (const url of ['http://127.0.0.1:1234/responses', 'ws://localhost:1234', 'http://[::1]:1234']) {
      expect(() => assertLoopbackOnly(url, 'stderr'), url).not.toThrow();
    }
  });
});
