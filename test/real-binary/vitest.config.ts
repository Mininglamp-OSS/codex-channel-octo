import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Real-binary contract job (R8 §6.3, §10.2): pinned codex 0.142.3, mock
// Responses provider over loopback, isolated homes, cases run sequentially.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('../../', import.meta.url)),
    include: ['test/real-binary/**/*.real.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 180_000,
    hookTimeout: 60_000,
    reporters: ['default', './test/harness/report/case-reporter.ts'],
  },
});
