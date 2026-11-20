// The test build's seed (p2-design section 10), run by `node scripts/test-build-d1.mjs seed --persist-to <dir>` after
// `migrate`: opens the local D1 of wrangler.test.jsonc under `<dir>/v3` through wrangler's getPlatformProxy and writes
// the invented brand (seed.ts) through the data layer. Prints the seeded member ids. Exit 1 on any failure.
// Not one batch: the seed writes through the stores' own flows (an invite, then the sign-in that binds it, reading the
// row the invite made), as requests would, so each write is its own transaction with its audit line. A seed that fails
// part way therefore leaves rows behind, and the next run refuses the database: the refusal names the folder to delete.
// https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy (read 2026-11-20)
import { getPlatformProxy } from 'wrangler'
import { openStores } from '../db/stores.ts'
import type { StoresEnv } from '../db/stores.ts'
import { seedBrand } from './seed.ts'

// Node's process, typed here without pulling Node's types into the Worker's program.
const proc = (globalThis as unknown as { process: { argv: string[]; exitCode?: number } }).process

const args = proc.argv.slice(2)
const at = args.indexOf('--persist-to')
const persistTo = at >= 0 ? args[at + 1] : undefined
if (!persistTo || args.length !== 2) {
  console.error('seed: usage: node server/seed/run.ts --persist-to <dir>')
  proc.exitCode = 2
} else {
  const { env, dispose } = await getPlatformProxy<StoresEnv>({ configPath: 'wrangler.test.jsonc', persist: { path: `${persistTo}/v3` } })
  try {
    const seeded = await seedBrand(env.DB, openStores(env), Date.now())
    console.log(JSON.stringify({ seeded: seeded.members }))
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    console.error(`seed: start again from an empty database: delete ${persistTo}, then run test-build:migrate and test-build:seed with --persist-to ${persistTo}.`)
    proc.exitCode = 1
  } finally {
    await dispose()
  }
}
