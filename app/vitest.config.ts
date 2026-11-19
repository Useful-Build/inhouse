import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Property tests live in src/**/*.property.test.ts, the other unit tests (the contract suite, the formatter tests) in
// src/**/*.test.ts, the build helpers' tests (the demo deploy redirect) in build-support/. The Playwright specs in e2e/ are never picked up here.
export default defineConfig({
  resolve: {
    alias: {
      // The demo client entry, as in tsconfig.app.json; vite.config.ts picks it by mode.
      '@client': fileURLToPath(new URL('./src/agent/client.demo.ts', import.meta.url)),
      '@sample': fileURLToPath(new URL('./src/agent/sample-data', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.property.test.ts', 'src/**/*.test.ts', 'build-support/**/*.test.ts'],
    environment: 'node',
    // Node 24.11.1 has a V8 garbage-collector bug: a mark-compact pass crashes with SIGSEGV
    // (ClearStaleLeftTrimmedPointerVisitor) when it meets a baseline (Sparkplug) frame. The property tests hit it on long
    // strings (6 of 10 runs of 1000 cases). Turning Sparkplug off passed 8 of 8. CI runs Node 26; the flag is for local
    // Node 24.11.1, which engines >=24 allows. Remove it once the supported floor is past the bug (check by running
    // VITE_PROP_RUNS=1000 npm run test:unit ten times without the flag).
    execArgv: ['--no-sparkplug'],
    // The slowest property takes about 7 s at 1000 cases (the whole file about 41 s), so 25 s fails a hang fast and leaves room.
    testTimeout: 25_000,
  },
})
