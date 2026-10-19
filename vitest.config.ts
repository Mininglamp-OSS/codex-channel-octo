import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Checker/tsc subprocess integration tests otherwise compete with the
    // existing short timer tests on two-core runners. Keep their real
    // assertions; schedule files sequentially instead of loosening timers.
    fileParallelism: false,
    maxWorkers: 1,
    // The real-binary contract suite runs only via `npm run test:real-binary`
    // (test/real-binary/vitest.config.ts); egress fixtures are scan inputs.
    exclude: [...configDefaults.exclude, 'test/real-binary/**', 'test/egress/fixtures/**', '.cache/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.d.ts'],
      // No hard thresholds yet — Stage 6 sets baseline; thresholds added once
      // current coverage is measured and we know what reasonable numbers look like.
    },
  },
});
