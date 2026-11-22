// Routes 16 to 18 on the real migrations. Ways they can fail, written down first:
//  1. two live grants at once, under any interleaving of creates and ends;
//  2. an ended grant still gives access on the next check;
//  3. a create or an end that applied writes no line, or one that didn't writes one; an expiry logs more than once;
//  4. an end with a stale rev, or of a grant no longer live, applies.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GrantsListSchema, SupportGrantSchema } from '../../shared/contract/grants.ts'
import { openStores } from '../db/stores.ts'
import { ctx, lastLineId, linesSince, person, personPrincipal, reset } from '../db/test-support.ts'
import { createGrant, endGrant, listGrants } from './grants.ts'
import { recordingAgent } from '../testing/brand-agent/recording-agent.ts'

const db = env.DB
const stores = openStores(env)
const T = 1_800_000_000_000
let u = 0
const uniq = () => `${++u}-${Math.random().toString(36).slice(2, 7)}`
let admin: string

beforeEach(async () => {
  await reset(db)
  admin = await person(stores, { email: `g-${uniq()}@example.test`, subject: `sg-${uniq()}`, role: 'admin' })
})

const json = async (r: Promise<Response>) => {
  const res = await r
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
// P3 W1 PR 4: the handlers now tell the BrandAgent after their batch, so they get an env (a recording stand-in here).
const create = (hours: unknown, nowMs = T, agent = recordingAgent()) =>
  json(createGrant({ ...ctx(stores, personPrincipal(admin, 'admin'), { method: 'POST', path: '/api/grants', body: { hours }, nowMs }).c, env: agent.env }))
const end = (id: string, ifRev: number, nowMs = T, agent = recordingAgent()) =>
  json(endGrant({ ...ctx(stores, personPrincipal(admin, 'admin'), { method: 'POST', path: `/api/grants/${id}/end`, params: { id }, body: { ifRev }, nowMs }).c, env: agent.env }))
const liveCount = async (nowMs: number) => (await db.prepare('SELECT COUNT(*) AS n FROM support_grants WHERE ended_at_ms IS NULL AND ends_at_ms > ?').bind(nowMs).first<number>('n'))!

describe('one live grant (failure 1)', () => {
  test.prop([fc.array(fc.oneof(fc.constant('create' as const), fc.constant('end' as const)), { minLength: 1, maxLength: 10 }), fc.boolean()], { numRuns: 30 })(
    'under any interleaving of creates and ends, at most one is live',
    async (ops, together) => {
      await reset(db)
      const run = async (op: 'create' | 'end') => {
        if (op === 'create') return create(4)
        const live = await db.prepare('SELECT id, rev FROM support_grants WHERE ended_at_ms IS NULL').first<{ id: string; rev: number }>()
        return live ? end(live.id, live.rev) : null
      }
      if (together) await Promise.all(ops.map(run))
      else for (const op of ops) {
        await run(op)
        expect(await liveCount(T)).toBeLessThanOrEqual(1)
      }
      expect(await liveCount(T)).toBeLessThanOrEqual(1)
    },
  )
  it('a second create while one is live is 409 grant_live, and writes nothing', async () => {
    expect((await create(1)).status).toBe(201)
    const before = await lastLineId(db)
    expect(await create(24)).toEqual({ status: 409, body: { error: { code: 'conflict', reason: 'grant_live' } } })
    expect(await linesSince(db, before)).toEqual([])
  })
  it('refuses hours outside 1, 4, 24 and 72', async () => {
    for (const h of [0, 2, 48, 73, '4', null]) expect((await create(h)).status).toBe(400)
  })
})

describe('ending (failures 2 to 4)', () => {
  it('ends at once: no access on the next check; one line each for the create and the end', async () => {
    const before = await lastLineId(db)
    const made = SupportGrantSchema.parse((await create(4)).body)
    expect(made).toMatchObject({ live: true, rev: 1, createdBy: admin, endsAt: { ms: T + 4 * 3_600_000 } })
    expect(await stores.grants.active({ nowMs: T, requestId: 'r' })).toEqual({ id: made.id, endsAtMs: made.endsAt.ms })
    const ended = await end(made.id, 1, T + 1000)
    expect(ended).toMatchObject({ status: 200, body: { live: false, endedBy: admin, rev: 2 } })
    expect(await stores.grants.active({ nowMs: T + 1001, requestId: 'r' })).toBeNull()
    expect((await linesSince(db, before)).map(l => [l.action, l.actor_id])).toEqual([['grant.created', admin], ['grant.ended', admin]])
    // Ended early: no expiry line when its time later runs out.
    await stores.grants.active({ nowMs: T + 5 * 3_600_000, requestId: 'r' })
    expect((await linesSince(db, before)).map(l => l.action)).toEqual(['grant.created', 'grant.ended'])
  })
  it('a stale rev, an ended or an expired grant is 409 with the record as it is; an unknown one 404', async () => {
    const made = SupportGrantSchema.parse((await create(1)).body)
    expect(await end(made.id, 2)).toMatchObject({ status: 409, body: { error: { code: 'conflict', current: { id: made.id, rev: 1, live: true } } } })
    expect(await end(made.id, 1, T + 3_600_000)).toMatchObject({ status: 409, body: { error: { current: { live: false } } } })
    expect((await end('g_nope', 1)).status).toBe(404)
    expect((await end('not a grant', 1)).status).toBe(404)
  })
  it('lists newest first, live flag at the request time, and logs an expiry once', async () => {
    const a = SupportGrantSchema.parse((await create(1, T)).body)
    const before = await lastLineId(db)
    const later = T + 2 * 3_600_000
    const b = SupportGrantSchema.parse((await create(4, later)).body)
    const list = GrantsListSchema.parse((await json(listGrants(ctx(stores, personPrincipal(admin, 'admin'), { path: '/api/grants', nowMs: later }).c))).body)
    expect(list.items.map(g => [g.id, g.live])).toEqual([[b.id, true], [a.id, false]])
    expect((await linesSince(db, before)).map(l => [l.action, l.at_ms])).toEqual([['grant.expired', a.endsAt.ms], ['grant.created', later]])
  })
})

describe('ending vs the logged expiry (fix round 1)', () => {
  it('a grant whose expiry is logged can not also be ended, even by a request whose clock is just before ends_at_ms', async () => {
    const made = SupportGrantSchema.parse((await create(1)).body)
    const before = await lastLineId(db)
    // A request with a later clock sees it run out and logs the expiry.
    await stores.grants.active({ nowMs: made.endsAt.ms + 1, requestId: 'r' })
    const ended = await end(made.id, 1, made.endsAt.ms - 1)
    expect(ended).toMatchObject({ status: 409, body: { error: { code: 'conflict', current: { id: made.id, rev: 1, endedAt: null } } } })
    expect((await linesSince(db, before)).map(l => l.action)).toEqual(['grant.expired'])
  })
})

// P3 W1 PR 4 (p3-design 4.10): the call sites. Ways they can fail: the expiry task is asked for another time than the
// grant's end, the object hears of a refused create or end, hears of an end before D1 has it, or a lost call turns a
// done write into an error.
describe('the BrandAgent hears of grants (P3 4.10)', () => {
  it('a create asks for the grant-expiry at the grant\'s end; a refused create says nothing', async () => {
    const agent = recordingAgent()
    const made = await create(4, T, agent)
    expect(made.status).toBe(201)
    expect(agent.calls).toEqual([{ method: 'onGrantCreated', args: [made.body.id, T + 4 * 3_600_000] }])
    expect((await create(1, T, agent)).status).toBe(409)
    expect(agent.calls).toHaveLength(1)
  })
  it('an end tells the object after the batch, once; a stale end says nothing', async () => {
    const made = await create(24)
    const id = made.body.id as string
    const seen: (number | null)[] = []
    const agent = recordingAgent({ onCall: async () => { seen.push(await db.prepare('SELECT ended_at_ms FROM support_grants WHERE id = ?').bind(id).first<number | null>('ended_at_ms')) } })
    expect((await end(id, 99, T + 1000, agent)).status).toBe(409)
    expect(agent.calls).toEqual([])
    expect((await end(id, made.body.rev as number, T + 1000, agent)).status).toBe(200)
    expect(agent.calls).toEqual([{ method: 'onGrantEnded', args: [id] }])
    expect(seen, 'D1 already had the end when the object was told').toEqual([T + 1000])
  })
  it('a lost call still answers the write (the sweep repairs it)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const made = await create(1, T, recordingAgent({ fails: true }))
    expect(made.status).toBe(201)
    expect((await end(made.body.id as string, made.body.rev as number, T + 1000, recordingAgent({ fails: true }))).status).toBe(200)
    expect(err.mock.calls.map(c => (c[0] as { call: string }).call)).toEqual(['onGrantCreated', 'onGrantEnded'])
    err.mockRestore()
  })
})
