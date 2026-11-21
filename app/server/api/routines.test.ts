// Routes 52 to 56 and route 33's routine-trace rule (P4 W2, p4-w2.md sections 9 and 10; test 10) through the real
// request path (api.ts, the real routes, matrix rows, stores and migrations; sign-in and the BrandAgent stood in for).
// Ways it can fail, written down first:
//  1. a person switches, deletes or restores a routine that isn't theirs (not an Admin); an Admin or Inhouse under a
//     grant can't; Inhouse without a grant gets in; a grant write leaves no support.access line;
//  2. a stale ifRev writes, or answers anything but conflict with the routine as it is now;
//  3. Run now isn't idempotent by clientKey, opens a second run for one routine, runs a deleted routine, a team routine
//     below its stage, or refuses a disabled one; a clientKey with a "." gets in;
//  4. restore backfills the slots missed while deleted; a write's audit or Activity line is missing, doubled or names
//     a routine's text;
//  5. canManage says yes where the write would refuse (or no where it would pass); the list leaks a deleted routine
//     into `routines`;
//  6. route 33: a person can't read a routine run's trace, or can read another person's chat trace, or a chat owned by
//     the routine principal with no slot row is readable.
import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { accessMatrix } from '../access-matrix.ts'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import { checkAccess } from '../auth/matrix.ts'
import type { Principal } from '../auth/principal.ts'
import { openStores } from '../db/stores.ts'
import { lastLineId, linesSince } from '../db/test-support.ts'
import { routes } from '../routes.ts'
import { addPerson, fresh, insertRoutine, routine, setStage, setZone, slotsOf } from '../routines/test-kit.ts'

const db = env.DB
const NOW = Date.parse('2026-06-01T12:00:00Z')
const ALEX = 'm_rt_alex'
const SAM = 'm_rt_sam'
const ADMIN = 'm_rt_admin'
const IH = 'm_rt_ih'
const GRANT = 'g_rttest'

const person = (memberId: string, role: 'member' | 'admin' = 'member'): Principal => ({ kind: 'person', memberId, role, subject: `s-${memberId}`, requestId: `req-${Math.random()}`, expMs: NOW + 600_000 })
const inhouse = (live: boolean): Principal => ({ kind: 'inhouse', memberId: IH, subject: 's-ih', grant: live ? { id: GRANT, endsAtMs: NOW + 60_000 } : null, requestId: `req-${Math.random()}`, expMs: NOW + 600_000 })

/** The BrandAgent stand-in: counts pokes, and answers traces by scope (a routine turn for `m_system`, Alex's own for Alex). */
let pokes = 0
const TRACES: Record<string, string> = { t_RoutineTurnAAAAAAAAAAA: 'm_system', t_AlexTurnAAAAAAAAAAAAAA: ALEX, t_OrphanTurnAAAAAAAAAAAA: 'm_system' }
const agent = {
  poke: async (p: { kind: string; id: string }) => {
    if (p.kind !== 'routine-tick' || p.id !== 'routine-poke') throw new Error('an unexpected poke')
    pokes++
  },
  getTrace: async (id: string, scope: { owner: string } | { all: true }) =>
    (Object.hasOwn(TRACES, id) && ('all' in scope || TRACES[id] === scope.owner) ? { id, steps: [] } : null),
}
const testEnv = { ...env, BRAND_AGENT: { getByName: () => agent } } as unknown as Env

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
async function send(principal: Principal, method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown) {
  const parts: ApiParts = { authenticate: async () => ({ principal }), checkOrigin: () => null, checkAccess, stores: e => openStores(e), routes, accessMatrix }
  const req = new Request(`http://brand.localhost:8787${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', Origin: 'http://brand.localhost:8787' },
  })
  const res = await api(parts, req, testEnv, ctx, `req-${Math.random()}`)
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}
const list = async (p: Principal) => (await send(p, 'GET', '/api/routines')).body as { routines: Record<string, any>[]; deleted: Record<string, any>[] }
const row = (id: string) => db.prepare('SELECT rev, enabled, deleted_at_ms, checked_until_ms FROM routines WHERE id = ?').bind(id).first()
const actions = async (since: number) => (await linesSince(db, since)).map(l => [l.action, l.actor_id])

beforeAll(async () => {
  // api.ts reads the clock itself (Date.now): fixed here so `next`, the grant and the stamps are literal.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  await addPerson(ALEX)
  await addPerson(SAM)
  await addPerson(ADMIN, 'admin')
  await db.prepare("INSERT INTO members (id, kind, status, name, subject, created_at_ms) VALUES (?, 'inhouse', 'active', 'Ian', 's-ih', 1) ON CONFLICT DO NOTHING").bind(IH).run()
})
afterAll(() => {
  vi.useRealTimers()
})
beforeEach(async () => {
  await fresh()
  await setZone('America/New_York')
  await setStage('Act')
  pokes = 0
})

describe('route 52: the list', () => {
  it('lists live routines (newest first) and deleted ones apart, with words, next, need, canManage and rev', async () => {
    const a = await insertRoutine(routine({ creator_id: ALEX, checked_until_ms: NOW, days_mask: 31, hour: 6, minute: 30, created_at_ms: NOW - 2 }))
    const b = await insertRoutine(routine({ creator_id: SAM, checked_until_ms: NOW, days_mask: 1 | 8, created_at_ms: NOW - 1, instruction: 'x'.repeat(300) }))
    const gone = await insertRoutine(routine({ creator_id: ALEX, checked_until_ms: NOW, deleted_at_ms: NOW - 5 }))
    const seen = await list(person(ALEX))
    expect(seen.routines.map(r => r.id)).toEqual([b.id, a.id])
    expect(seen.deleted.map(r => r.id)).toEqual([gone.id])
    expect((seen as unknown as { enabled: Record<string, boolean> }).enabled).toEqual({ [a.id]: true, [b.id]: true, [gone.id]: true })
    // 2026-06-01 is a Monday; 12:00Z is 08:00 EDT, so the next weekday 06:30 is Tuesday's (10:30Z).
    expect(seen.routines[1]).toEqual({
      id: a.id, name: 'Check stock', what: 'Check the stock levels.', freq: 'Weekdays', day: '', time: { hour: 6, minute: 30 },
      next: { iso: '2026-06-02T10:30:00.000Z', ms: Date.parse('2026-06-02T10:30:00Z') }, need: 1, canManage: true, rev: 1,
    })
    expect(seen.routines[0]).toMatchObject({ freq: 'Weekly', day: 'Monday, Thursday', canManage: false })
    expect(seen.routines[0].what).toHaveLength(200)
    expect((await list(person(ADMIN, 'admin'))).routines.every(r => r.canManage)).toBe(true)
  })

  it('the Inhouse team reads only under a grant, after a support.access line', async () => {
    await insertRoutine(routine({ creator_id: ALEX, checked_until_ms: NOW }))
    expect((await send(inhouse(false), 'GET', '/api/routines')).body).toEqual({ error: { code: 'forbidden', reason: 'grant_required' } })
    const before = await lastLineId(db)
    const r = await send(inhouse(true), 'GET', '/api/routines')
    expect(r.status).toBe(200)
    expect((r.body.routines as Record<string, any>[]).every(x => x.canManage)).toBe(true)
    expect((await linesSince(db, before)).map(l => [l.action, JSON.parse(l.args_json)])).toEqual([['support.access', { grantId: GRANT, method: 'GET', route: '/api/routines' }]])
  })
})

describe('routes 53, 55 and 56: switch, delete and restore', () => {
  it('the creator, an Admin and Inhouse under a grant may; another member may not, and nothing changes', async () => {
    const r = await insertRoutine(routine({ creator_id: ALEX, checked_until_ms: NOW - 3 * 86_400_000 }))
    const no = await send(person(SAM), 'PUT', `/api/routines/${r.id}/enabled`, { on: false, ifRev: 1 })
    expect(no).toEqual({ status: 403, body: { error: { code: 'forbidden', reason: 'not_owner' } } })
    for (const path of ['delete', 'restore']) expect((await send(person(SAM), 'POST', `/api/routines/${r.id}/${path}`, { ifRev: 1 })).status, path).not.toBe(200)
    expect(await row(r.id)).toMatchObject({ rev: 1, enabled: 1, deleted_at_ms: null })
    expect(pokes).toBe(0)

    const before = await lastLineId(db)
    const off = await send(person(ALEX), 'PUT', `/api/routines/${r.id}/enabled`, { on: false, ifRev: 1 })
    expect(off.status).toBe(200)
    expect(off.body).toMatchObject({ id: r.id, rev: 2, canManage: true })
    const del = await send(person(ADMIN, 'admin'), 'POST', `/api/routines/${r.id}/delete`, { ifRev: 2 })
    expect(del.body).toMatchObject({ rev: 3 })
    const back = await send(inhouse(true), 'POST', `/api/routines/${r.id}/restore`, { ifRev: 3 })
    expect(back.body).toMatchObject({ rev: 4 })
    // Restored with its cursor at now: no backfill of the days it was gone.
    expect(await row(r.id)).toMatchObject({ rev: 4, enabled: 0, deleted_at_ms: null, checked_until_ms: NOW })
    expect(await actions(before)).toEqual([
      ['routine.enabled', ALEX], ['routine.deleted', ADMIN], ['support.access', IH], ['routine.restored', IH],
    ])
    const lines = (await db.prepare("SELECT template, actor_id, fields_json FROM activity_lines WHERE source = 'routine' AND source_key LIKE ? ORDER BY source_key").bind(`${r.id}|%`).all()).results
    expect(lines).toEqual([
      { template: 'routine_changed', actor_id: ALEX, fields_json: '{}' },
      { template: 'routine_deleted', actor_id: ADMIN, fields_json: '{}' },
      { template: 'routine_restored', actor_id: IH, fields_json: '{}' },
    ])
    // A switch and a restore poke the tick; a delete has nothing for it to do.
    expect(pokes).toBe(2)
  })

  it('Inhouse without a grant is refused before the handler; a stale ifRev is conflict with the routine as it is now', async () => {
    const r = await insertRoutine(routine({ creator_id: ALEX, checked_until_ms: NOW }))
    expect((await send(inhouse(false), 'PUT', `/api/routines/${r.id}/enabled`, { on: false, ifRev: 1 })).body).toEqual({ error: { code: 'forbidden', reason: 'grant_required' } })
    await send(person(ALEX), 'PUT', `/api/routines/${r.id}/enabled`, { on: false, ifRev: 1 })
    const stale = await send(person(ALEX), 'POST', `/api/routines/${r.id}/delete`, { ifRev: 1 })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatchObject({ code: 'conflict', current: { id: r.id, rev: 2 } })
    expect(await row(r.id)).toMatchObject({ rev: 2, deleted_at_ms: null })
  })

  it('an unknown routine, a bad id or a bad body is refused and writes nothing', async () => {
    const before = await lastLineId(db)
    expect((await send(person(ALEX), 'PUT', '/api/routines/rt_NobodyAAAAAAAAAAAAAAAA/enabled', { on: true, ifRev: 1 })).status).toBe(404)
    expect((await send(person(ALEX), 'POST', '/api/routines/not-an-id!/delete', { ifRev: 1 })).status).toBe(404)
    const r = await insertRoutine(routine({ creator_id: ALEX, checked_until_ms: NOW }))
    expect((await send(person(ALEX), 'PUT', `/api/routines/${r.id}/enabled`, { on: 'yes', ifRev: 1 })).status).toBe(400)
    expect((await send(person(ALEX), 'POST', `/api/routines/${r.id}/delete`, { ifRev: 1, extra: 1 })).status).toBe(400)
    expect(await actions(before)).toEqual([])
  })
})

describe('route 54: Run now', () => {
  it('is idempotent by clientKey, one open run per routine (run_open with that run), allowed on a disabled routine', async () => {
    const r = await insertRoutine(routine({ creator_id: ALEX, checked_until_ms: NOW, enabled: 0 }))
    const first = await send(person(SAM), 'POST', `/api/routines/${r.id}/run`, { clientKey: 'run-key-0001' })
    expect(first).toEqual({ status: 200, body: { routine: r.id, at: { iso: new Date(NOW).toISOString(), ms: NOW } } })
    expect(await send(person(SAM), 'POST', `/api/routines/${r.id}/run`, { clientKey: 'run-key-0001' })).toEqual(first)
    const second = await send(person(ALEX), 'POST', `/api/routines/${r.id}/run`, { clientKey: 'run-key-0002' })
    expect(second).toEqual({ status: 409, body: { error: { code: 'conflict', reason: 'run_open', current: first.body } } })
    expect((await slotsOf(r.id)).map(s => [s.kind, s.state, s.requested_by])).toEqual([['manual', 'claimed', SAM]])
    expect(pokes).toBe(2)
    const lines = await db.prepare("SELECT actor_id FROM audit_log WHERE action = 'routine.run_now' AND target_id = ?").bind(r.id).all()
    expect(lines.results).toEqual([{ actor_id: SAM }])
  })

  it('a deleted routine is 404; a team routine below its stage is forbidden/stage; a key with a "." is invalid', async () => {
    const gone = await insertRoutine(routine({ creator_id: ALEX, checked_until_ms: NOW, deleted_at_ms: NOW - 1 }))
    expect((await send(person(ALEX), 'POST', `/api/routines/${gone.id}/run`, { clientKey: 'run-key-0003' })).status).toBe(404)
    const team = await insertRoutine(routine({ creator_id: ALEX, checked_until_ms: NOW }))
    expect((await send(person(ALEX), 'POST', `/api/routines/${team.id}/run`, { clientKey: 'run.key.0004' })).status).toBe(400)
    await setStage('Watch')
    expect((await send(person(ALEX), 'POST', `/api/routines/${team.id}/run`, { clientKey: 'run-key-0005' })).body).toEqual({ error: { code: 'forbidden', reason: 'stage' } })
    expect(await slotsOf(team.id)).toEqual([])
  })
})

describe('route 33: a routine run\'s trace (OC 6)', () => {
  beforeEach(async () => {
    await db.prepare("DELETE FROM chats WHERE id IN ('rc_trace_routine', 'rc_trace_orphan')").run()
    const r = await insertRoutine(routine({ creator_id: ALEX, checked_until_ms: NOW }))
    await db.batch([
      db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES ('rc_trace_routine', 'm_system', 'Check stock, 2026-06-01', 0, 0)"),
      db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES ('rc_trace_orphan', 'm_system', 'Orphan', 0, 0)"),
      db.prepare(
        `INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, local_time, tz, due_at_ms, deadline_ms, state, chat_id, client_key,
            prompt_text, submit_json, routine_rev, creator_id, claimed_at_ms, run_id, turn_id)
          VALUES (?, ?, 'scheduled', '2026-06-01', '06:00', 'America/New_York', 0, 0, 'ended', 'rc_trace_routine', 'rs_key', 'x', '{}', 1, ?, 0, 'r_RoutineRunAAAAAAAAAAAA', 't_RoutineTurnAAAAAAAAAAA')`,
      ).bind(`${r.id}|2026-06-01|06:00`, r.id, ALEX),
    ])
  })

  it('any person reads a routine run\'s trace; still not another person\'s; a routine-principal chat with no slot stays 404', async () => {
    for (const who of [person(SAM), person(ALEX), person(ADMIN, 'admin')]) {
      expect((await send(who, 'GET', '/api/traces/t_RoutineTurnAAAAAAAAAAA')).status).toBe(200)
    }
    expect((await send(person(SAM), 'GET', '/api/traces/t_AlexTurnAAAAAAAAAAAAAA')).status).toBe(404)
    expect((await send(person(ALEX), 'GET', '/api/traces/t_AlexTurnAAAAAAAAAAAAAA')).status).toBe(200)
    expect((await send(person(SAM), 'GET', '/api/traces/t_OrphanTurnAAAAAAAAAAAA')).status).toBe(404)
  })
})
