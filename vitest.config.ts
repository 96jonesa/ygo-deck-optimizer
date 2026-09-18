import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The property oracles run tens of thousands of cases in one test; they
    // take ~2.5 s locally and over 6 s on a CI runner, past vitest's 5 s default.
    testTimeout: 60_000,
  },
});
