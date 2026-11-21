import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Property tests live in src/**/*.property.test.ts, the other unit tests (the contract suite, the formatter tests) in
// src/**/*.test.ts, the build helpers' tests (the demo deploy redirect) in build-support/. The Playwright specs in e2e/ are never picked up here
// (the test build's helpers in e2e/support/ have unit tests of their own, which are).
// The product Worker's tests (P2) live beside their code: server/**/*.test.ts run in the Workers runtime (the `server`
// project, @cloudflare/vitest-plugin's cloudflareTest() on wrangler.test.jsonc, with a local D1 that has the real
// migrations applied: server/testing/apply-migrations.ts). Everything else runs in node (the `node` project), the
// scripts' own tests in scripts/**/*.test.mjs. Call 9 (2026-11-20): @cloudflare/vitest-plugin 1.6.0 (2026-11-05, the
// latest at least two weeks old) has peer vitest ^4.1.0 || ^5.0.0 and brings its own wrangler, so no node:sqlite adapter.
// Its workerd (1.20261104, beside the repo's own 1.20261113) supports compatibility dates up to 2026-11-11, below
// wrangler.test.jsonc's 2026-11-13, so the server tests run at 2026-11-11 on an older workerd than the test build.
// That pin was checked against 2026-11-13 only: when wrangler.test.jsonc's date moves, this config refuses to load until
// someone re-checks the plugin's workerd (a newer plugin two weeks old may support the date: then drop compatibilityDate).
const PIN_CHECKED_AGAINST = '2026-11-13'
const testConfigDate = /"compatibility_date"\s*:\s*"([^"]+)"/.exec(readFileSync(new URL('./wrangler.test.jsonc', import.meta.url), 'utf8'))?.[1]
if (testConfigDate !== PIN_CHECKED_AGAINST) {
  throw new Error(
    `vitest.config.ts: wrangler.test.jsonc's compatibility_date is ${testConfigDate ?? 'missing'}, but the server project's ` +
    `2026-11-11 pin was checked against ${PIN_CHECKED_AGAINST}. Re-check which dates @cloudflare/vitest-plugin's workerd ` +
    'supports, then update the pin and PIN_CHECKED_AGAINST.',
  )
}
const alias = {
  // The demo client entry, as in tsconfig.app.json; vite.config.ts picks it by mode.
  '@client': fileURLToPath(new URL('./src/agent/client.demo.ts', import.meta.url)),
  '@sample': fileURLToPath(new URL('./src/agent/sample-data', import.meta.url)),
  // W1's test issuer, as in the test build (vite.config.ts): its tests import the real one.
  '@test-issuer': fileURLToPath(new URL('./server/auth/test-issuer.ts', import.meta.url)),
  // The scripted model (P3), as in the test build (vite.config.ts).
  '@scripted-model': fileURLToPath(new URL('./test/scripted-model/index.ts', import.meta.url)),
  // The eval trace, as in the eval build (vite.config.ts): its tests import the real one. Code that reads it is switched by
  // `__INHOUSE_EVAL_BUILD__` (false below), so every other test sees a product build.
  '@eval-trace': fileURLToPath(new URL('./server/eval-trace/on.ts', import.meta.url)),
  '@': fileURLToPath(new URL('./src', import.meta.url)),
}

export default defineConfig({
  resolve: { alias },
  // The test and eval builds' compile-time switches (vite.config.ts): off here, as in the product build.
  define: { __INHOUSE_TEST_BUILD__: 'false', __INHOUSE_EVAL_BUILD__: 'false' },
  test: {
    // The slowest property takes about 7 s at 1000 cases (the whole file about 41 s), so 25 s fails a hang fast and leaves room.
    testTimeout: 25_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: [
            'src/**/*.property.test.ts', 'src/**/*.test.ts', 'build-support/**/*.test.ts', 'e2e/support/**/*.test.ts',
            'ops/**/*.test.ts', 'shared/**/*.test.ts', 'evals/**/*.test.ts', 'scripts/**/*.test.mjs',
          ],
          environment: 'node',
          // The contract suite's real target (src/agent/contract/targets.ts reads it with `inject`): the test build's
          // origin, set by e2e/support/test-build/serve.ts. Read here from the environment, so it can't be dropped on the way.
          provide: { contractRealOrigin: process.env.CONTRACT_REAL_ORIGIN ?? '' },
          // Node 24.11.1 has a V8 garbage-collector bug: a mark-compact pass crashes with SIGSEGV
          // (ClearStaleLeftTrimmedPointerVisitor) when it meets a baseline (Sparkplug) frame. The property tests hit it on long
          // strings (6 of 10 runs of 1000 cases). Turning Sparkplug off passed 8 of 8. CI runs Node 26; the flag is for local
          // Node 24.11.1, which engines >=24 allows. Remove it once the supported floor is past the bug (check by running
          // VITE_PROP_RUNS=1000 npm run test:unit ten times without the flag).
          execArgv: ['--no-sparkplug'],
        },
      },
      {
        extends: true,
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.test.jsonc' },
            miniflare: {
              compatibilityDate: '2026-11-11',
              bindings: { TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL('./server/migrations', import.meta.url))) },
            },
          })),
        ],
        test: {
          name: 'server',
          include: ['server/**/*.test.ts'],
          setupFiles: ['server/testing/apply-migrations.ts'],
        },
      },
    ],
  },
})
