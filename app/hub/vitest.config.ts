import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Three projects. `node`: plain Node, so the hub's pure logic (crypto, scope, registry, the SignIn core) runs on a
// worker's seat without workerd. `workers`: workerd through the Cloudflare plugin on the TEST config, for what needs
// the runtime (Durable Object storage, the Worker's exports). CI runs both (`npm test`). `live`: the Shopify recorder
// and the nightly against the real read fixture store (`npm run test:live`), never in `npm test` or CI. Globals, because
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
          include: ['**/*.test.ts'],
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
          exclude: ['**/node_modules/**'],
        },
      },
      {
        define: { __INHOUSE_HUB_TEST__: 'false' },
        test: {
          name: 'live',
          environment: 'node',
          globals: true,
          include: ['../test/connectors/shopify/**/*.live.ts', '../test/upstreams/shopify/**/*.live.ts'],
        },
      },
    ],
  },
})
