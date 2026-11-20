// Proves the `server` project collects ops/{backup,retention,export,delete} tests and binds the test-only RESTORE_DB
// (a second local D1, the restore's target). G1 replaces this file's job with its own tests; delete it then.
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'

const e = env as Env & { RESTORE_DB: D1Database, TEST_MIGRATIONS: D1Migration[] }

it('runs in the Workers runtime with DB and a separate RESTORE_DB', async () => {
  expect(e.RESTORE_DB).toBeDefined()
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  const tables = (await e.RESTORE_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'members'").all()).results
  expect(tables).toHaveLength(1)
  // Not the same database as DB: a row written to one is absent from the other.
  await e.RESTORE_DB.prepare("CREATE TABLE restore_only (x INTEGER)").run()
  const inDb = (await e.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'restore_only'").all()).results
  expect(inDb).toHaveLength(0)
})
