import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['node_modules/', 'dist/', '**/*.test.ts', 'vitest.config.ts'],
    },
    testTimeout: 10000,
  },
});
