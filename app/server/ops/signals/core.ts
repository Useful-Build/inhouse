// P2's health signals: the deployed version, D1 answering, and every migration this build ships being applied (P3 PR0
// retired latest.ts's single pointer, p3-design section 11: workers add migrations in blocks, so the newest number isn't
// the last one applied, and a lower number applied later on a reused sandbox still reads correctly).
import type { HandlerEnv } from '../../routes.ts'
import type { Signal } from './types.ts'
import { EVAL_BUILD_FLAVOR } from '@eval-trace'

declare const __INHOUSE_TEST_BUILD__: boolean
declare const __INHOUSE_EVAL_BUILD__: boolean

/**
 * The Worker version's id, from the version metadata binding when the config has one
 * (https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/, read 2026-11-20), else null.
 */
export function versionOf(env: HandlerEnv): string | null {
  const meta = (env as { CF_VERSION_METADATA?: { id?: unknown } }).CF_VERSION_METADATA
  return typeof meta?.id === 'string' && meta.id !== '' ? meta.id : null
}

/**
 * The deployed version and the build's flavor (p3-eval-observability rev 2, rec 4): `product`, `test`, or the eval
 * build's `eval (<canary>)`, so a release can see which bundle answers (the ops repo's release smoke refuses any flavor
 * but `product`). A release's config has the `version_metadata` binding (wrangler.product.jsonc), so a Worker without it
 * is misconfigured and fails. A test or eval bundle runs only with its runtime switch on (`INHOUSE_TEST_BUILD === '1'`,
 * as the test issuer does): without it, it's that bundle under a product config, and fails. With it, it may run without
 * version metadata, and its detail says so. `compiledTestBuild` and `evalFlavor` are seams for the unit tests (vitest
 * compiles neither in).
 */
export function versionSignal(
  compiledTestBuild: boolean = __INHOUSE_TEST_BUILD__,
  evalFlavor: string | null = __INHOUSE_EVAL_BUILD__ ? EVAL_BUILD_FLAVOR : null,
): Signal {
  const flavor = evalFlavor ?? (compiledTestBuild ? 'test' : 'product')
  return {
    name: 'version',
    async check({ env }) {
      const id = versionOf(env)
      const switchedOn = (env as { INHOUSE_TEST_BUILD?: unknown }).INHOUSE_TEST_BUILD === '1'
      if (compiledTestBuild && !switchedOn) return { ok: false, detail: `${id ?? 'no version metadata'} · ${flavor} build without its switch` }
      if (id !== null) return { ok: true, detail: `${id} · ${flavor} build` }
      return compiledTestBuild ? { ok: true, detail: `no version metadata (${flavor} build)` } : { ok: false, detail: 'no version metadata · product build' }
    },
  }
}

/**
 * The migrations this build ships: every server/migrations/*.sql file's name without `.sql`, read by Vite at build time
 * (the file contents come along; only the names are used).
 */
export const SHIPPED_MIGRATIONS: readonly string[] = Object.keys(import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true }))
  .map(path => path.slice(path.lastIndexOf('/') + 1).replace(/\.sql$/, ''))
  .sort()

/** Ok when every shipped migration is applied, whatever else is (an applied one this build doesn't ship is fine). */
export function migrationsSignal(shipped: readonly string[] = SHIPPED_MIGRATIONS): Signal {
  return {
    name: 'migrations',
    async check({ stores }) {
      if (shipped.length === 0) return { ok: false, detail: 'this build ships no migrations' }
      const applied = new Set(await stores.health.appliedMigrations())
      const missing = shipped.filter(name => !applied.has(name))
      return missing.length ? { ok: false, detail: `not applied: ${missing.join(', ')}` } : { ok: true, detail: `${shipped.length} applied` }
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
  migrationsSignal(),
]
