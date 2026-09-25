import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests start their own anvil node.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
