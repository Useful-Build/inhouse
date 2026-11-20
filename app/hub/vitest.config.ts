import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Two projects. `node`: plain Node, so the hub's pure logic (crypto, scope, registry, the SignIn core) runs on a
// worker's seat without workerd. `workers`: workerd through the Cloudflare plugin on the TEST config, for what needs
// the runtime (Durable Object storage, the Worker's exports). CI runs both (`npm test`).
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
    ],
  },
})
