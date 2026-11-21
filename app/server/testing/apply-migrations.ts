// Setup for the server tests (vitest.config.ts's `server` project, in the Workers runtime): every test file gets the
// test config's local D1 with the real migrations (server/migrations/) applied. Storage is isolated per test file.
// https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/ (D1 migrations)
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] }
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS)
