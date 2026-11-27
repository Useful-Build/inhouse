// Setup for the hub's `workers-eval` project (vitest.config.ts, Stage 1 M3): the eval D1 the eval hub binds as
// EVAL_WRITE_LOG gets the product's real migrations (server/migrations/), as the eval deployment's database has them.
// Storage is isolated per test file. Never bundled: no config's `main` reaches it.
// https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/ (D1 migrations)
import { applyD1Migrations, env } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'

const evalEnv = env as unknown as { EVAL_WRITE_LOG: D1Database; TEST_MIGRATIONS: D1Migration[] }
await applyD1Migrations(evalEnv.EVAL_WRITE_LOG, evalEnv.TEST_MIGRATIONS)
