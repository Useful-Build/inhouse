// M4-P0 spike only. Run: npx vitest run -c spike-egress/vitest.config.ts (from app/hub, via heavy-lock).
// Configured entirely through miniflare options, so the hub's real configs are untouched.
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

const here = import.meta.dirname
const DATE = '2026-11-11'

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: join(here, 'hub.ts'),
      miniflare: {
        compatibilityDate: DATE,
        workerLoaders: { LOADER: {} },
        // The hub's own outbound goes to the fixture (the stand-in internet).
        outboundService: 'fixture',
        serviceBindings: {
          FIXTURE_LOG: { name: 'fixture', entrypoint: 'Log' },
          CONNECTOR: { name: 'connector', entrypoint: 'Connector' },
        },
        workers: [
          { name: 'fixture', modules: true, compatibilityDate: DATE, script: readFileSync(join(here, 'fixture.js'), 'utf8') },
          // Shape 2's Worker: like production, nothing restricts its outbound; it goes to the same stand-in internet.
          { name: 'connector', modules: true, compatibilityDate: DATE, outboundService: 'fixture', script: readFileSync(join(here, 'connector-worker.js'), 'utf8') },
        ],
      },
    }),
  ],
  test: { include: [join(here, 'egress.spike.ts')] },
})
