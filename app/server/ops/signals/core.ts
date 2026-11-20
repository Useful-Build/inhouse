// P2's health signals: the deployed version, D1 answering, and the last applied migration being the newest this build
// knows (server/migrations/latest.ts).
import { LATEST_MIGRATION } from '../../migrations/latest.ts'
import type { HandlerEnv } from '../../routes.ts'
import type { Signal } from './types.ts'

/**
 * The Worker version's id, from the version metadata binding when the config has one
 * (https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/, read 2026-11-20), else null.
 */
export function versionOf(env: HandlerEnv): string | null {
  const meta = (env as { CF_VERSION_METADATA?: { id?: unknown } }).CF_VERSION_METADATA
  return typeof meta?.id === 'string' && meta.id !== '' ? meta.id : null
}

export const coreSignals: readonly Signal[] = [
  {
    // Informational: a Worker without the binding (the test build) still runs; the detail says so.
    name: 'version',
    async check({ env }) {
      const id = versionOf(env)
      return { ok: true, detail: id ?? 'no version metadata' }
    },
  },
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
