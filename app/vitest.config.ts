import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Unit and property tests live in src/**/*.property.test.ts. The Playwright specs in e2e/ are never picked up here.
export default defineConfig({
  resolve: {
    alias: {
      '@sample': fileURLToPath(new URL('./src/agent/sample-data', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.property.test.ts'],
    environment: 'node',
    // The properties load the store afresh on every run, so a high VITE_PROP_RUNS needs room.
    testTimeout: 600_000,
  },
})
