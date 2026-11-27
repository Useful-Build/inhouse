import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// Four projects. `node`: plain Node, so the hub's pure logic (crypto, scope, registry, the SignIn core) runs on a
// worker's seat without workerd. `workers`: workerd through the Cloudflare plugin on the TEST config, for what needs
// the runtime (Durable Object storage, the Worker's exports). CI runs both (`npm test`). `live`: the Shopify recorder
// and the nightly against the real read fixture store (`npm run test:live`), never in `npm test` or CI. `workers-eval`
// (Stage 1 M3, N31): the same test config as the eval deployment's hub runs it, with the eval D1 bound as EVAL_WRITE_LOG
// (the product's migrations applied), for `*.eval.workers.test.ts` only: that binding switches the Slack fake to the
// eval workspace, so the other workers tests keep the fixture. CI runs it with the other two (`npm test`). Globals, because
// its files live in app/test/, where CI has no node_modules to resolve `vitest` from (they type the two globals they use).
export default defineConfig({
  test: {
    projects: [
      {
        // The deployable value: node tests see the hub as it ships, with the test seam's branch off.
        define: { __INHOUSE_HUB_TEST__: 'false' },
        test: {
          name: 'node',
          environment: 'node',
          // P5 W5: the nightly connector cases' own test (test/connectors/mcp/run.test.ts) runs here too.
          include: ['**/*.test.ts', '../test/connectors/mcp/**/*.test.ts'],
          exclude: ['**/*.workers.test.ts', '**/node_modules/**'],
        },
      },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: '../wrangler.hub.test.jsonc' } })],
        // The test config's define, applied to the test bundle too, so the guarded seam is live under workerd.
        define: { __INHOUSE_HUB_TEST__: 'true' },
        test: {
          name: 'workers',
          include: ['**/*.workers.test.ts'],
          exclude: ['**/node_modules/**', '**/*.eval.workers.test.ts'],
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: '../wrangler.hub.test.jsonc' },
            miniflare: {
              // As the eval hub binds it (scripts/check-product-config.mjs EVAL_WRITE_LOG_BINDING): a local D1, test only.
              d1Databases: { EVAL_WRITE_LOG: '00000000-0000-4000-8000-0000000000e1' },
              bindings: { TEST_MIGRATIONS: await readD1Migrations(join(import.meta.dirname, '../server/migrations')) },
            },
          })),
        ],
        define: { __INHOUSE_HUB_TEST__: 'true' },
        test: {
          name: 'workers-eval',
          include: ['**/*.eval.workers.test.ts'],
          exclude: ['**/node_modules/**'],
          setupFiles: ['testing/eval-migrations.ts'],
        },
      },
      {
        define: { __INHOUSE_HUB_TEST__: 'false' },
        test: {
          name: 'live',
          environment: 'node',
          globals: true,
          // P5 W5: the Slack nightly (test/connectors/mcp/slack.live.ts).
          include: ['../test/connectors/shopify/**/*.live.ts', '../test/upstreams/shopify/**/*.live.ts', '../test/connectors/mcp/**/*.live.ts'],
        },
      },
    ],
  },
})
