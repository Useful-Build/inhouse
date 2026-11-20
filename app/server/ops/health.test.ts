// Route 1 (the health route) on the real migrations. Ways it can fail, written down first:
//  1. it answers 200 while a signal fails, or 503 while all pass;
//  2. a signal that throws takes the route down (500) instead of failing its own entry;
//  3. a detail carries brand data (an error message, a name, an email);
//  4. the migration signal passes when the last applied migration isn't the newest one this build knows.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { HandlerEnv } from '../routes.ts'
import { openStores } from '../db/stores.ts'
import { LATEST_MIGRATION } from '../migrations/latest.ts'
import { coreSignals } from './signals/core.ts'
import { signals } from './signals/index.ts'
import { health, healthHandler } from './health.ts'

const stores = openStores(env)
const c = { env: {} as HandlerEnv, stores }
const call = async (h: ReturnType<typeof healthHandler>, ctx = c) => {
  const res = await h(ctx)
  return { status: res.status, body: (await res.json()) as { version: string | null; ok: boolean; signals: { name: string; ok: boolean; detail?: string }[] } }
}

describe('the health route', () => {
  it('lists P2 signals in the registry and answers 200 when all pass (failure 1)', async () => {
    expect(signals.map(s => s.name)).toEqual(expect.arrayContaining(['version', 'd1', 'migrations']))
    expect(await call(health)).toEqual({
      status: 200,
      body: { version: null, ok: true, signals: [
        { name: 'version', ok: true, detail: 'no version metadata' }, { name: 'd1', ok: true }, { name: 'migrations', ok: true, detail: LATEST_MIGRATION },
      ] },
    })
    const versioned = await call(health, { ...c, env: { CF_VERSION_METADATA: { id: 'v-123', tag: '', timestamp: '' } } as unknown as HandlerEnv })
    expect(versioned.body.version).toBe('v-123')
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
  it('fails the migration signal when the last applied migration is not the newest (failure 4)', async () => {
    const behind = { ...stores, health: { ...stores.health, lastMigration: async () => '0004_audit_log.sql' } }
    const out = await call(health, { ...c, stores: behind })
    expect(out.status).toBe(503)
    expect(out.body.signals.find(s => s.name === 'migrations')).toEqual({ name: 'migrations', ok: false, detail: `applied 0004_audit_log, expected ${LATEST_MIGRATION}` })
  })
})
