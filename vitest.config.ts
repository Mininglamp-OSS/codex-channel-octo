import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
