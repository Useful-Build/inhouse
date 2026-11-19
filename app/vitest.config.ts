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
    // Node 24.11.1 has a V8 garbage-collector bug: a mark-compact pass crashes with SIGSEGV
    // (ClearStaleLeftTrimmedPointerVisitor) when it meets a baseline (Sparkplug) frame. The property tests hit it on long
    // strings (6 of 10 runs of 1000 cases). Turning Sparkplug off passed 8 of 8. Remove this once CI and .nvmrc run a Node
    // with the fix (check by running VITE_PROP_RUNS=1000 npm run test:unit ten times without the flag).
    execArgv: ['--no-sparkplug'],
    // The slowest property takes about 7 s at 1000 cases (the whole file about 41 s), so 25 s fails a hang fast and leaves room.
    testTimeout: 25_000,
  },
})
