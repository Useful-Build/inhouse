// Route 1 (the health route) on the real migrations. Ways it can fail, written down first:
//  1. it answers 200 while a signal fails, or 503 while all pass;
//  2. a signal that throws takes the route down (500) instead of failing its own entry;
//  3. a detail carries brand data (an error message, a name, an email);
//  4. the migration signal passes when a migration this build ships isn't applied (P3: every shipped one, in any order,
//     not just the newest: latest.ts is retired), or fails when every shipped one is applied beside others;
//  5. a release without the version metadata binding answers 200 healthy instead of failing the version signal (503).
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { HandlerEnv } from '../routes.ts'
import { openStores } from '../db/stores.ts'
import { SHIPPED_MIGRATIONS, coreSignals, migrationsSignal, versionSignal } from './signals/core.ts'
import { signals } from './signals/index.ts'
import { health, healthHandler } from './health.ts'

const stores = openStores(env)
// P3 lists signals that ask the BrandAgent (runs) and read the usage ledger (usage_stranded): the env carries the binding.
const VERSIONED = { CF_VERSION_METADATA: { id: 'v-123', tag: '', timestamp: '' }, BRAND_AGENT: env.BRAND_AGENT } as unknown as HandlerEnv
const c = { env: VERSIONED, stores }
const call = async (h: ReturnType<typeof healthHandler>, ctx = c) => {
  const res = await h(ctx)
  return { status: res.status, body: (await res.json()) as { version: string | null; ok: boolean; signals: { name: string; ok: boolean; detail?: string }[] } }
}

describe('the health route', () => {
  it('lists P2 signals in the registry and answers 200 when all pass (failure 1)', async () => {
    expect(signals.map(s => s.name)).toEqual(expect.arrayContaining(['version', 'd1', 'migrations']))
    expect(await call(health)).toEqual({
      status: 200,
      body: { version: 'v-123', ok: true, signals: [
        { name: 'version', ok: true, detail: 'v-123' }, { name: 'd1', ok: true }, { name: 'migrations', ok: true, detail: `${SHIPPED_MIGRATIONS.length} applied` },
        { name: 'runs_failed', ok: true, detail: '0 of 0 failed in the last hour' }, { name: 'runs_stuck', ok: true, detail: '0 stuck' },
        { name: 'session_damaged', ok: true, detail: '0 damaged in 24 h' }, { name: 'scheduler', ok: true, detail: '0 quarantined' },
        { name: 'usage_stranded', ok: true },
      ] },
    })
  })
  it('fails the version signal without the binding, except in the test build (failure 5)', async () => {
    const bare = { ...c, env: {} as HandlerEnv }
    // Not the test build (this test's own compile: __INHOUSE_TEST_BUILD__ is false), with or without the runtime switch.
    for (const env of [{}, { INHOUSE_TEST_BUILD: '1' }] as unknown as HandlerEnv[]) {
      const out = await call(health, { ...bare, env })
      expect(out.status).toBe(503)
      expect(out.body.version).toBeNull()
      expect(out.body.signals[0]).toEqual({ name: 'version', ok: false, detail: 'no version metadata' })
    }
    // A test build is compiled in and switched on: it may run without one, and says so.
    const testBuild = versionSignal(true)
    expect(await testBuild.check({ env: { INHOUSE_TEST_BUILD: '1' } as unknown as HandlerEnv, stores })).toEqual({ ok: true, detail: 'no version metadata (test build)' })
    expect(await testBuild.check({ env: {} as HandlerEnv, stores }), 'compiled in but not switched on').toEqual({ ok: false, detail: 'no version metadata' })
    expect(await testBuild.check({ env: VERSIONED, stores })).toEqual({ ok: true, detail: 'v-123' })
    for (const id of ['', 7, undefined]) {
      expect(await versionSignal(false).check({ env: { CF_VERSION_METADATA: { id } } as unknown as HandlerEnv, stores })).toEqual({ ok: false, detail: 'no version metadata' })
    }
  })
  it('answers 503 when one fails, and a throwing signal fails alone with its error name only (failures 1 to 3)', async () => {
    const out = await call(healthHandler([
      ...coreSignals,
      { name: 'boom', async check() { throw new TypeError('dana@example.test leaked') } },
      { name: 'down', async check() { return { ok: false, detail: 'down' } } },
    ]))
    expect(out.status).toBe(503)
    expect(out.body.ok).toBe(false)
    expect(out.body.signals.slice(3)).toEqual([{ name: 'boom', ok: false, detail: 'TypeError' }, { name: 'down', ok: false, detail: 'down' }])
    expect(JSON.stringify(out.body)).not.toContain('@')
  })
  it('fails the migration signal when a shipped migration is not applied (failure 4)', async () => {
    const behind = { ...stores, health: { ...stores.health, appliedMigrations: async () => ['0001_members', '0002_settings', '0003_support_grants', '0005_service_rows', '0100_chats', '0101_tool_calls', '0120_chat_files', '0130_usage'] } }
    const out = await call(health, { ...c, stores: behind })
    expect(out.status).toBe(503)
    expect(out.body.signals.find(s => s.name === 'migrations')).toEqual({ name: 'migrations', ok: false, detail: 'not applied: 0004_audit_log' })
  })
  it('compares sets, not the newest name (failure 4, P3 blocks)', async () => {
    // Literal sets: P3's workers add blocks (0100, 0120, ...), so a lower number can land and be applied after a higher one.
    const shipped = ['0005_service_rows', '0100_chats', '0120_chat_files']
    const run = (applied: string[]) => migrationsSignal(shipped).check({ env: VERSIONED, stores: { ...stores, health: { ...stores.health, appliedMigrations: async () => applied } } })
    expect(await run(['0120_chat_files', '0005_service_rows', '0100_chats'])).toEqual({ ok: true, detail: '3 applied' })
    expect(await run(['0005_service_rows', '0120_chat_files'])).toEqual({ ok: false, detail: 'not applied: 0100_chats' })
    expect(await run(['0005_service_rows', '0100_chats', '0120_chat_files', '0130_usage'])).toEqual({ ok: true, detail: '3 applied' })
    expect(await run([])).toEqual({ ok: false, detail: 'not applied: 0005_service_rows, 0100_chats, 0120_chat_files' })
    expect(await migrationsSignal([]).check({ env: VERSIONED, stores })).toEqual({ ok: false, detail: 'this build ships no migrations' })
  })
})
