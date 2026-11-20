// What sign-in reads of support grants (the live grant, the lazy expiry line) and the support.access line. Grants are
// written directly here: the create and end routes come with PR 3. Ways it can fail, written down first:
//  1. an ended or expired grant still gives access on the next check (or one ending exactly now does);
//  2. `grant.expired` is written twice (two requests at once) or never, or not at `ends_at_ms`, or for a grant an
//     Admin ended early;
//  3. the expiry flag is set while its line fails;
//  4. a support.access line is written without a live grant, or names a concrete path.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { openStores } from './stores.ts'
import { brokenAudit, lastLineId, linesSince, reqId, reset, snapshot } from './test-support.ts'

const db = env.DB
const stores = openStores(env)
const T = 1_800_000_000_000
let g = 0
const grant = async (endsAtMs: number, endedAtMs: number | null = null) => {
  const id = `g_t${++g}`
  await db.prepare("INSERT INTO support_grants (id, created_by, created_at_ms, ends_at_ms, ended_at_ms) VALUES (?, 'm_system', ?, ?, ?)").bind(id, endsAtMs - 3_600_000, endsAtMs, endedAtMs).run()
  return id
}

beforeEach(() => reset(db))

describe('the live grant (failure 1)', () => {
  it('is live until ends_at_ms (exclusive); an ended one never is', async () => {
    const id = await grant(T + 1000)
    expect(await stores.grants.active({ nowMs: T, requestId: reqId() })).toEqual({ id, endsAtMs: T + 1000 })
    expect(await stores.grants.active({ nowMs: T + 1000, requestId: reqId() })).toBeNull()
    await reset(db)
    await grant(T + 1000, T - 1)
    expect(await stores.grants.active({ nowMs: T, requestId: reqId() })).toBeNull()
  })
})

describe('the expiry line (failures 2, 3)', () => {
  test.prop([fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 100_000 })], { numRuns: 20 })('is written once, by the system row, at ends_at_ms, however many requests see it', async (n, late) => {
    await reset(db)
    const ends = T + 5000
    const id = await grant(ends)
    const early = await grant(ends, T)
    const before = await lastLineId(db)
    await Promise.all(Array.from({ length: n }, () => stores.grants.active({ nowMs: ends + late, requestId: reqId() })))
    await stores.grants.active({ nowMs: ends + late + 1, requestId: reqId() })
    const lines = await linesSince(db, before)
    expect(lines.map(l => [l.action, l.actor_id, l.at_ms, JSON.parse(l.args_json)])).toEqual([['grant.expired', 'm_system', ends, { grantId: id }]])
    expect(lines.some(l => l.target_id === early)).toBe(false)
  })
  it('leaves the flag unset when its line fails', async () => {
    await grant(T - 1)
    const before = await snapshot(db)
    await expect(openStores(env, brokenAudit).grants.active({ nowMs: T, requestId: reqId() })).rejects.toThrow()
    expect(await snapshot(db)).toEqual(before)
  })
})

describe('support.access (failure 4)', () => {
  it('writes one line naming the grant and the route pattern; refuses without a grant or with a concrete path', async () => {
    const id = await grant(T + 1000)
    const inhouse = await stores.members.resolveInhouse({ subject: 'sub-support', email: 'support@example.test', requestId: reqId(), nowMs: T })
    const before = await lastLineId(db)
    await stores.audit.supportAccess({ ...inhouse, grant: { id, endsAtMs: T + 1000 } }, { method: 'GET', route: '/api/members', nowMs: T })
    const lines = await linesSince(db, before)
    expect(lines.map(l => [l.action, l.actor_id, JSON.parse(l.args_json)])).toEqual([['support.access', inhouse.memberId, { grantId: id, method: 'GET', route: '/api/members' }]])
    await expect(stores.audit.supportAccess({ ...inhouse, grant: null }, { method: 'GET', route: '/api/members', nowMs: T })).rejects.toThrow()
    await expect(stores.audit.supportAccess({ ...inhouse, grant: { id, endsAtMs: T + 1000 } }, { method: 'GET', route: `/api/members/${inhouse.memberId}/photo`, nowMs: T })).rejects.toThrow()
    expect(await linesSince(db, before)).toHaveLength(1)
  })
})
