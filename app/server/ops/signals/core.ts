// P2's health signals: the deployed version, D1 answering, and the last applied migration being the newest this build
// knows (server/migrations/latest.ts).
import { LATEST_MIGRATION } from '../../migrations/latest.ts'
import type { HandlerEnv } from '../../routes.ts'
import type { Signal } from './types.ts'

declare const __INHOUSE_TEST_BUILD__: boolean

/**
 * The Worker version's id, from the version metadata binding when the config has one
 * (https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/, read 2026-11-20), else null.
 */
export function versionOf(env: HandlerEnv): string | null {
  const meta = (env as { CF_VERSION_METADATA?: { id?: unknown } }).CF_VERSION_METADATA
  return typeof meta?.id === 'string' && meta.id !== '' ? meta.id : null
}

/**
 * The deployed version: a release's config has the `version_metadata` binding (wrangler.product.jsonc), so a Worker
 * without it is misconfigured and fails. Only the test build (compiled in and switched on, as the test issuer is) may run
 * without one, and its detail says so.
 */
export function versionSignal(compiledTestBuild: boolean = __INHOUSE_TEST_BUILD__): Signal {
  return {
    name: 'version',
    async check({ env }) {
      const id = versionOf(env)
      if (id !== null) return { ok: true, detail: id }
      const testBuild = compiledTestBuild && (env as { INHOUSE_TEST_BUILD?: unknown }).INHOUSE_TEST_BUILD === '1'
      return testBuild ? { ok: true, detail: 'no version metadata (test build)' } : { ok: false, detail: 'no version metadata' }
    },
  }
}

export const coreSignals: readonly Signal[] = [
  versionSignal(),
  {
    name: 'd1',
    async check({ stores }) {
      await stores.health.ping()
      return { ok: true }
    },
  },
  {
    name: 'migrations',
    async check({ stores }) {
      const last = (await stores.health.lastMigration())?.replace(/\.sql$/, '') ?? null
      return last === LATEST_MIGRATION ? { ok: true, detail: last } : { ok: false, detail: `applied ${last ?? 'none'}, expected ${LATEST_MIGRATION}` }
    },
  },
]
