// Routines (P4 W2 routes 52 to 56, acceptance 1 and 8; p4-w2.md sections 4, 7 and 9, p4-w6.md sections 1 to 3; route 68,
// master plan decision 8). Five groups:
//   1. the routes: who may do what to which routine (Dana made it, Leo is another Member, the Admin, Inhouse with and
//      without a live grant), `ifRev` conflicts answering the current record, Run now idempotent by `clientKey`;
//   2. stage gating: at Watch a chat's `routine_create` is refused with the design's words and makes no row, the morning
//      check's Run now still works, at Act the same call creates the routine, back at Watch its next slot is `skipped`;
//   3. slots against the real scheduler: the BrandAgent's alarm driven through route 67's controls, with routines whose
//      times are set relative to the spec's own start (the clock can't be moved);
//   4. the next run the page shows for a schedule in the brand's zone (`next` is computed, not waited for);
//   5. route 68: a routine's own recent runs, newest first, in plain words, read like route 52.
// The expected answers are written here from the briefs' tables, never read from the code. Every group needs the multi-config
// test build (`needsWatchBuild`): the routines are seeded into the local D1, and the slot cases run a turn in a container.
// The slot math across a skipped and a repeated local time is W2's workers test (`p4-w2.md` tests 1 to 3): a brand zone can't
// place a slot inside a transition on the real clock. The zone `next` cases check a daily 06:00 schedule against a literal
// 2026 and 2027 offset table (`watch-pure.ts`, which throws loudly outside those two years: extend it then); a schedule at a
// skipped or repeated local time is W2's.
import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { actor, call, endLiveGrants, expectConflict, expectError, putSetting } from './kit.ts'
import type { Actor } from './kit.ts'
import { auditWhere, readSql, writeSql } from './db.ts'
import { answerOf, createChat, send, textOf } from './chat-kit.ts'
import {
  BRAND_TZ, P4_ROUTES, alarmAndTick, alarmControl, localSlot, memberIdOf, needsLocalD1, needsWatchBuild, retireRoutines, routineRow, seedRoutine, setStage, slotWhere, slotsOf, trackRoutine, turnsInChat,
} from './watch-kit.ts'
import { caseFor } from './cases.ts'
import { expectedNextDaily } from '../support/watch-pure.ts'
import { ROUTINE_CREATED_ANSWER, ROUTINE_REFUSED_ANSWER } from '../../test/scripted-model/scenarios.ts'

const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
const inhouse = actor('inhouse')

const MORNING_CHECK = 'routine-morning-check'
const runKey = () => randomBytes(16).toString('hex')
const HOUR = 3_600_000

interface Def { id: string; name: string; rev: number; canManage?: boolean; next: { ms: number }; time: { hour: number; minute: number }; last?: { at: { ms: number }; result: string } }
const list = async (request: Parameters<typeof call>[0], who: Actor) => {
  const r = await call(request, who, 'GET', '/api/routines')
  expect(r.status, r.text).toBe(200)
  return r.json as { routines: Def[]; deleted: Def[]; enabled: Record<string, boolean> }
}
const defOf = (page: { routines: Def[]; deleted: Def[] }, id: string) => [...page.routines, ...page.deleted].find(r => r.id === id)

test.describe('routes 52 to 56: who may do what to which routine', () => {
  needsLocalD1()
  test.describe.configure({ mode: 'serial' })
  let routine: string
  let danaId: string

  test.beforeAll(async ({ request }) => {
    await endLiveGrants(request)
    danaId = await memberIdOf(request, dana)
    routine = seedRoutine({ creatorId: danaId, hour: 6, minute: 0, instruction: 'scenario:hello E2E routine routes', need: 0 })
  })
  test.afterAll(async ({ request }) => {
    await endLiveGrants(request)
    retireRoutines()
  })

  test('every P4 routine route without a JWT, or with a garbage one, is 401 unauthorized', async ({ request }) => {
    for (const key of P4_ROUTES.filter(k => k.includes('/api/routines'))) {
      const [method, pattern] = key.split(' ') as [string, string]
      const c = caseFor({ method, pattern })
      for (const token of [null, 'not-a-jwt']) {
        const r = await call(request, dana, method, c.path, { token, ...(c.json === undefined ? {} : { json: c.json }) })
        expectError(r, 401, 'unauthorized')
      }
    }
  })

  test('the list: each person sees the routine, and `canManage` says who may switch it (Dana made it; the morning check is the system\'s)', async ({ request }) => {
    const expected: [string, Actor, boolean, boolean][] = [
      ['Dana (the creator)', dana, true, false],
      ['Leo (another Member)', leo, false, false],
      ['the Admin', admin, true, true],
    ]
    for (const [who, a, canManageRoutine, canManageSystem] of expected) {
      const page = await list(request, a)
      expect(defOf(page, routine), `${who} sees the routine`).toMatchObject({ canManage: canManageRoutine, rev: 1, time: { hour: 6, minute: 0 } })
      expect(defOf(page, MORNING_CHECK), `${who} sees the morning check`).toMatchObject({ canManage: canManageSystem })
      expect(page.enabled[routine], `${who}: the switch`).toBe(true)
      expect(page.deleted.map(r => r.id)).not.toContain(routine)
    }
    // A query string is not part of the route.
    expectError(await call(request, dana, 'GET', '/api/routines?limit=1'), 400, 'invalid')
  })

  test('Inhouse: no live grant is 403 grant_required on every route; under a live grant it reads, and manages every routine', async ({ request }) => {
    const body = { on: false, ifRev: 1 }
    expectError(await call(request, inhouse, 'GET', '/api/routines'), 403, 'forbidden', 'grant_required')
    expectError(await call(request, inhouse, 'PUT', `/api/routines/${routine}/enabled`, { json: body }), 403, 'forbidden', 'grant_required')
    expectError(await call(request, inhouse, 'POST', `/api/routines/${routine}/run`, { json: { clientKey: runKey() } }), 403, 'forbidden', 'grant_required')
    expect(routineRow(routine)).toMatchObject({ rev: 1, enabled: 1 })
    const grant = await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })
    expect(grant.status, grant.text).toBe(201)
    const read = await call(request, inhouse, 'GET', '/api/routines')
    expect(read.status, `a 503 here means support.access lacks the route pattern (PR0 #237): ${read.text}`).toBe(200)
    expect(defOf(read.json, routine)).toMatchObject({ canManage: true })
    await endLiveGrants(request)
  })

  test('switching off and on: the creator and an Admin may, Leo may not (403 not_owner, nothing changed); Inhouse under a grant may; each is one audit line', async ({ request }) => {
    const before = auditWhere('routine.enabled').length
    const refused = await call(request, leo, 'PUT', `/api/routines/${routine}/enabled`, { json: { on: false, ifRev: 1 } })
    expectError(refused, 403, 'forbidden', 'not_owner')
    expect(routineRow(routine)).toMatchObject({ rev: 1, enabled: 1 })

    const off = await call(request, dana, 'PUT', `/api/routines/${routine}/enabled`, { json: { on: false, ifRev: 1 } })
    expect(off.status, off.text).toBe(200)
    expect(off.json).toMatchObject({ enabled: false, routine: { id: routine, rev: 2 } })
    expect(routineRow(routine)).toMatchObject({ rev: 2, enabled: 0 })

    // The same revision again is stale: 409 with the record as it is now.
    const stale = expectConflict(await call(request, dana, 'PUT', `/api/routines/${routine}/enabled`, { json: { on: true, ifRev: 1 } }))
    expect(stale).toMatchObject({ enabled: false, routine: { id: routine, rev: 2 } })

    const on = await call(request, admin, 'PUT', `/api/routines/${routine}/enabled`, { json: { on: true, ifRev: 2 } })
    expect(on.status, on.text).toBe(200)
    expect(on.json).toMatchObject({ enabled: true, routine: { rev: 3 } })

    expect((await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })).status).toBe(201)
    const byInhouse = await call(request, inhouse, 'PUT', `/api/routines/${routine}/enabled`, { json: { on: false, ifRev: 3 } })
    expect(byInhouse.status, `a 503 here means support.access lacks the write pattern (PR0 #237): ${byInhouse.text}`).toBe(200)
    expect(byInhouse.json).toMatchObject({ enabled: false, routine: { rev: 4 } })
    await endLiveGrants(request)

    const lines = auditWhere('routine.enabled').slice(before).map(l => JSON.parse(l.args_json) as { routineId: string; on: boolean })
    expect(lines.filter(l => l.routineId === routine).map(l => l.on), 'one line per change, none for the refusal or the conflict').toEqual([false, true, false])
    const on2 = await call(request, dana, 'PUT', `/api/routines/${routine}/enabled`, { json: { on: true, ifRev: 4 } })
    expect(on2.status, on2.text).toBe(200)
  })

  test('route 53 and its neighbours refuse a body that is not exactly the schema, and an id that is not a routine id is 404', async ({ request }) => {
    for (const json of [{}, { on: true }, { ifRev: 5 }, { on: 'yes', ifRev: 5 }, { on: true, ifRev: 0 }, { on: true, ifRev: 5, extra: 1 }]) {
      const r = await call(request, dana, 'PUT', `/api/routines/${routine}/enabled`, { json })
      expect(r.status, JSON.stringify(json)).toBe(400)
      expect(r.json.error.code).toBe('invalid')
    }
    expectError(await call(request, dana, 'PUT', '/api/routines/not-an-id/enabled', { json: { on: true, ifRev: 1 } }), 404, 'not_found')
    for (const json of [{}, { ifRev: 0 }, { ifRev: 1, extra: true }]) {
      expect((await call(request, dana, 'POST', `/api/routines/${routine}/delete`, { json })).status, JSON.stringify(json)).toBe(400)
    }
  })

  test('delete and restore: Leo may not; the creator may; a deleted routine leaves the list for `deleted`, cannot Run now (404), and comes back with no backfill', async ({ request }) => {
    const rev = routineRow(routine)!.rev
    expectError(await call(request, leo, 'POST', `/api/routines/${routine}/delete`, { json: { ifRev: rev } }), 403, 'forbidden', 'not_owner')
    expect(routineRow(routine)!.deleted_at_ms).toBeNull()

    const gone = await call(request, dana, 'POST', `/api/routines/${routine}/delete`, { json: { ifRev: rev } })
    expect(gone.status, gone.text).toBe(200)
    expect(gone.json.routine.rev).toBe(rev + 1)
    const page = await list(request, leo)
    expect(page.routines.map(r => r.id)).not.toContain(routine)
    expect(page.deleted.map(r => r.id)).toContain(routine)
    expectError(await call(request, leo, 'POST', `/api/routines/${routine}/run`, { json: { clientKey: runKey() } }), 404, 'not_found')

    expect(expectConflict(await call(request, dana, 'POST', `/api/routines/${routine}/restore`, { json: { ifRev: rev } }))).toMatchObject({ routine: { id: routine, rev: rev + 1 } })
    const slotsBefore = slotsOf(routine).length
    const at = Date.now()
    const back = await call(request, admin, 'POST', `/api/routines/${routine}/restore`, { json: { ifRev: rev + 1 } })
    expect(back.status, back.text).toBe(200)
    expect(back.json.routine.rev).toBe(rev + 2)
    expect(routineRow(routine)!.checked_until_ms, 'restoring moves the cursor to now: no backfill').toBeGreaterThanOrEqual(at)
    expect((await list(request, dana)).routines.map(r => r.id)).toContain(routine)
    expect(slotsOf(routine).length).toBe(slotsBefore)
    expect(auditWhere('routine.deleted').some(l => (JSON.parse(l.args_json) as { routineId: string }).routineId === routine)).toBe(true)
    expect(auditWhere('routine.restored').some(l => (JSON.parse(l.args_json) as { routineId: string }).routineId === routine)).toBe(true)
  })

  test('Run now is anyone\'s, idempotent by `clientKey`; a second open Run now is a conflict that carries the open run; a bad key is invalid', async ({ request }) => {
    const id = seedRoutine({ creatorId: danaId, hour: 6, minute: 0, instruction: 'scenario:hello E2E run now', need: 0 })
    const key = runKey()
    const first = await call(request, leo, 'POST', `/api/routines/${id}/run`, { json: { clientKey: key } })
    expect(first.status, first.text).toBe(200)
    expect(first.json).toEqual({ routine: id, at: { iso: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), ms: expect.any(Number) } })
    // The same key again answers the same run, and there is one slot row for it.
    const again = await call(request, leo, 'POST', `/api/routines/${id}/run`, { json: { clientKey: key } })
    expect(again.status, again.text).toBe(200)
    expect(again.json).toEqual(first.json)
    expect(slotsOf(id).filter(s => s.slot_key === `now|${id}|${key}`)).toHaveLength(1)
    for (const bad of ['short', 'has a space in it', 'a.b.c.d.e.f.g.h', 'x'.repeat(65)]) {
      expect((await call(request, dana, 'POST', `/api/routines/${id}/run`, { json: { clientKey: bad } })).status, bad).toBe(400)
    }
    expectError(await call(request, dana, 'POST', `/api/routines/rt_e2eNobodyAAAAAAAAAAAAA/run`, { json: { clientKey: runKey() } }), 404, 'not_found')
    // Run now is audited once, by the person who pressed it.
    const lines = auditWhere('routine.run_now').filter(l => (JSON.parse(l.args_json) as { routineId: string }).routineId === id)
    expect(lines).toHaveLength(1)
  })

  test('a second Run now while one is open is a conflict that carries the open run: the open run is a claimed row the tick will not touch for an hour, so no timing decides it', async ({ request }) => {
    const id = seedRoutine({ creatorId: danaId, hour: 6, minute: 0, instruction: 'scenario:hello E2E open run', need: 0 })
    const now = Date.now()
    // A manual slot as route 54 writes it, left `claimed`: its next attempt and deadline are an hour away, so neither the heartbeat
    // nor a poke submits or closes it while the spec asks (a containerless build included).
    writeSql(
      `INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, local_time, tz, due_at_ms, deadline_ms, state, chat_id, client_key, prompt_text, submit_json, routine_rev, creator_id, next_attempt_ms, claimed_at_ms)
       VALUES (?, ?, 'manual', ?, NULL, ?, ?, ?, 'claimed', ?, ?, 'held', '{}', 1, ?, ?, ?)`,
      `now|${id}|e2eheldopenrun01`, id, localSlot(0).date, BRAND_TZ, now, now + HOUR, `rc_e2eHeld${id.slice(3, 15)}`, 'e2eheldopenrun01', danaId, now + HOUR, now,
    )
    for (const who of [admin, leo]) {
      const open = await call(request, who, 'POST', `/api/routines/${id}/run`, { json: { clientKey: runKey() } })
      expect(open.status, open.text).toBe(409)
      expect(open.json.error).toMatchObject({ code: 'conflict', reason: 'run_open', current: { routine: id } })
    }
    expect(slotsOf(id), 'the refused calls wrote nothing').toHaveLength(1)
  })
})

test.describe('route 68: a routine\'s own recent runs', () => {
  needsLocalD1()
  test.describe.configure({ mode: 'serial' })
  let danaId: string

  test.beforeAll(async ({ request }) => {
    await endLiveGrants(request)
    danaId = await memberIdOf(request, dana)
  })
  test.afterAll(async ({ request }) => {
    await endLiveGrants(request)
    retireRoutines()
  })

  /** A routine the tick leaves alone (switched off), so the only slots it has are the spec's. */
  const quietRoutine = (what: string) => {
    const id = seedRoutine({ creatorId: danaId, hour: 6, minute: 0, instruction: `scenario:hello E2E ${what}`, need: 0 })
    writeSql('UPDATE routines SET enabled = 0 WHERE id = ?', id)
    return id
  }
  /** One slot as the tick leaves it: `state`, and its end's fields when it ran. */
  const slot = (id: string, n: number, ms: number, o: { state: string; reason?: string; outcome?: string; failure?: string; result?: string; runId?: string }) => {
    const day = new Date(ms).toISOString().slice(0, 10)
    const ran = o.state === 'ended'
    writeSql(
      `INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, local_time, tz, due_at_ms, deadline_ms, state, reason, chat_id, client_key, prompt_text, submit_json, routine_rev, creator_id, claimed_at_ms, started_at_ms, ended_at_ms, run_id, outcome, failure, result_text)
       VALUES (?, ?, 'scheduled', ?, '06:00', ?, ?, ?, ?, ?, ?, ?, 'x', '{}', 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `${id}|${day}|06:00|${n}`, id, day, BRAND_TZ, ms, ms + 600_000, o.state, o.reason ?? null, `rc_e2eRuns${id.slice(3, 15)}${n}`, `rs_e2eruns${n}`, danaId,
      ms, ran ? ms : null, ran ? ms + 60_000 : null, o.runId ?? null, o.outcome ?? null, o.failure ?? null, o.result ?? null,
    )
  }
  const at = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })

  test('a routine with no runs is an empty list for every person; with runs, its own come back newest first in plain words', async ({ request }) => {
    const id = quietRoutine('route 68 runs')
    const other = quietRoutine('route 68 other')
    for (const who of [dana, leo, admin]) {
      const r = await call(request, who, 'GET', `/api/routines/${id}/runs`)
      expect(r.status, r.text).toBe(200)
      expect(r.json).toEqual({ runs: [] })
    }
    const day = 86_400_000
    const t0 = Date.now() - 3 * day
    slot(id, 1, t0, { state: 'missed', reason: 'late' })
    slot(id, 2, t0 + day, { state: 'ended', outcome: 'failed', failure: 'run_failed', runId: 'r_e2eRunsFailedAAAAAAAAA' })
    slot(id, 3, t0 + 2 * day, { state: 'ended', outcome: 'done', result: 'Found 2 low-stock items', runId: 'r_e2eRunsDoneAAAAAAAAAAA' })
    slot(other, 4, t0 + 2 * day, { state: 'ended', outcome: 'done', result: 'Not this routine' })
    const r = await call(request, leo, 'GET', `/api/routines/${id}/runs`)
    expect(r.status, r.text).toBe(200)
    expect(r.json).toEqual({
      runs: [
        { at: at(t0 + 2 * day), outcome: 'done', result: 'Found 2 low-stock items', manual: false, trace: 'r_e2eRunsDoneAAAAAAAAAAA' },
        { at: at(t0 + day), outcome: 'failed', result: 'It stopped before it finished', manual: false, trace: 'r_e2eRunsFailedAAAAAAAAA' },
        { at: at(t0), outcome: 'skipped', result: 'It missed its time', manual: false },
      ],
    })
  })

  test('another brand\'s routine (an id this brand doesn\'t have), a deleted one or a bad id is 404; a query is invalid', async ({ request }) => {
    expectError(await call(request, dana, 'GET', '/api/routines/rt_e2eOtherBrandAAAAAAAAA/runs'), 404, 'not_found')
    expectError(await call(request, dana, 'GET', '/api/routines/not-an-id/runs'), 404, 'not_found')
    const gone = quietRoutine('route 68 deleted')
    writeSql('UPDATE routines SET deleted_at_ms = ?, rev = rev + 1 WHERE id = ?', Date.now(), gone)
    expectError(await call(request, dana, 'GET', `/api/routines/${gone}/runs`), 404, 'not_found')
    const id = quietRoutine('route 68 query')
    expectError(await call(request, dana, 'GET', `/api/routines/${id}/runs?limit=50`), 400, 'invalid')
  })

  test('Inhouse: no live grant is 403 grant_required; under a live grant it reads, with a support.access line', async ({ request }) => {
    const id = quietRoutine('route 68 inhouse')
    expectError(await call(request, inhouse, 'GET', `/api/routines/${id}/runs`), 403, 'forbidden', 'grant_required')
    const grant = await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })
    expect(grant.status, grant.text).toBe(201)
    const before = auditWhere('support.access').length
    const read = await call(request, inhouse, 'GET', `/api/routines/${id}/runs`)
    expect(read.status, `a 503 here means support.access lacks the route pattern: ${read.text}`).toBe(200)
    expect(read.json).toEqual({ runs: [] })
    expect(auditWhere('support.access').slice(before).map(l => (JSON.parse(l.args_json) as { route: string }).route)).toContain('/api/routines/:id/runs')
    await endLiveGrants(request)
  })
})

test.describe('stage gating (acceptance 8)', () => {
  needsWatchBuild()
  test.describe.configure({ mode: 'serial', timeout: 600_000 })

  test.afterAll(async ({ request }) => {
    await setStage(request, 'Watch')
    retireRoutines()
  })

  test('at Watch a chat\'s routine_create is refused with the design\'s words and makes no routine; the morning check\'s Run now still works', async ({ request }) => {
    await setStage(request, 'Watch')
    const chat = await createChat(request, dana)
    const sent = await send(request, dana, chat, 'scenario:routine-create please set up a daily stock check')
    expect(textOf(await answerOf(request, dana, chat, sent.turnId))).toContain(ROUTINE_REFUSED_ANSWER)
    expect(readSql('SELECT id FROM routines WHERE source_chat_id = ?', chat), 'no routine row exists afterwards').toEqual([])

    const key = runKey()
    const run = await call(request, dana, 'POST', `/api/routines/${MORNING_CHECK}/run`, { json: { clientKey: key } })
    expect(run.status, run.text).toBe(200)
    // The run starts through the tick and ends: `started` is the proof it was submitted, `ended` frees the next Run now.
    const slot = `now|${MORNING_CHECK}|${key}`
    await expect.poll(() => slotsOf(MORNING_CHECK).find(s => s.slot_key === slot)?.state, { timeout: 300_000, message: 'the morning check\'s manual slot to end' }).toBe('ended')
  })

  test('at Act the same call creates the routine; back at Watch its next slot is skipped with reason stage', async ({ request }) => {
    await setStage(request, 'Act')
    const chat = await createChat(request, dana)
    const sent = await send(request, dana, chat, 'scenario:routine-create please set up a daily stock check')
    expect(textOf(await answerOf(request, dana, chat, sent.turnId))).toContain(ROUTINE_CREATED_ANSWER)
    const made = readSql<{ id: string; creator_id: string; need: number; origin: string }>('SELECT id, creator_id, need, origin FROM routines WHERE source_chat_id = ?', chat)
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({ creator_id: await memberIdOf(request, dana), need: 1, origin: 'team' })
    const id = made[0]!.id
    trackRoutine(id)

    await setStage(request, 'Watch')
    // Make it due: its time is a minute ago in the brand's zone and its cursor is five minutes back.
    const due = localSlot(1)
    writeSql('UPDATE routines SET hour = ?, minute = ?, rev = rev + 1 WHERE id = ?', due.hour, due.minute, id)
    const seeded = await alarmControl(request, { action: 'seedCursor', routineId: id, checkedUntilMs: Date.now() - 5 * 60_000 })
    expect(seeded.status, seeded.text).toBe(200)
    await alarmAndTick(request)
    const slot = await slotWhere(id, 'the team routine\'s slot at Watch', s => s.kind === 'scheduled', 60_000)
    expect(slot).toMatchObject({ state: 'skipped', reason: 'stage', turn_id: null })
    expect(slotsOf(id)).toHaveLength(1)
  })
})

test.describe('a team routine below its stage (acceptance 8)', () => {
  needsLocalD1()
  test.describe.configure({ mode: 'serial' })
  test.afterAll(async ({ request }) => {
    await setStage(request, 'Watch')
    retireRoutines()
  })

  test('a team routine\'s Run now below its stage is 403 stage, and allowed once the stage is Act', async ({ request }) => {
    await setStage(request, 'Watch')
    const id = seedRoutine({ creatorId: await memberIdOf(request, dana), hour: 6, minute: 0, instruction: 'scenario:hello E2E staged', need: 1 })
    expectError(await call(request, leo, 'POST', `/api/routines/${id}/run`, { json: { clientKey: runKey() } }), 403, 'forbidden', 'stage')
    expect(slotsOf(id)).toEqual([])
    await setStage(request, 'Act')
    const run = await call(request, leo, 'POST', `/api/routines/${id}/run`, { json: { clientKey: runKey() } })
    expect(run.status, run.text).toBe(200)
  })
})

test.describe('slots against the real scheduler and binding (acceptance 1)', () => {
  needsWatchBuild()
  test.describe.configure({ mode: 'serial', timeout: 600_000 })
  let danaId: string

  test.beforeAll(async ({ request }) => {
    await setStage(request, 'Watch')
    danaId = await memberIdOf(request, dana)
  })
  test.afterAll(() => retireRoutines())

  /** A routine due a minute ago in the brand's zone, with its cursor five minutes back: one on-time slot is waiting. */
  const dueRoutine = (extra: { missed?: 'skip' | 'catch_up' } = {}) => {
    const due = localSlot(1)
    return { id: seedRoutine({ creatorId: danaId, hour: due.hour, minute: due.minute, instruction: 'scenario:hello E2E slot', need: 0, checkedUntilMs: Date.now() - 5 * 60_000, ...extra }), due }
  }

  test('Run now: the claimed manual slot is submitted through the tick, its routine-end arrives, and a second Run now while it is open is a conflict', async ({ request }) => {
    const id = seedRoutine({ creatorId: danaId, hour: 6, minute: 0, instruction: 'scenario:hello E2E run now slot', need: 0 })
    const key = runKey()
    const run = await call(request, leo, 'POST', `/api/routines/${id}/run`, { json: { clientKey: key } })
    expect(run.status, run.text).toBe(200)
    const open = await call(request, leo, 'POST', `/api/routines/${id}/run`, { json: { clientKey: runKey() } })
    expect(open.status, open.text).toBe(409)
    expect(open.json.error.reason).toBe('run_open')

    const ended = await slotWhere(id, 'the manual slot to end', s => s.slot_key === `now|${id}|${key}` && s.state === 'ended')
    expect(ended).toMatchObject({ kind: 'manual', outcome: 'done', failure: null })
    expect(ended.turn_id).not.toBeNull()
    expect(turnsInChat(ended.chat_id)).toBe(1)
    // The routine's `last` is that end, and the next Run now is allowed again.
    const page = await list(request, dana)
    expect(defOf(page, id)?.last?.at.ms ?? 0).toBeGreaterThan(0)
    expect((await call(request, dana, 'POST', `/api/routines/${id}/run`, { json: { clientKey: runKey() } })).status).toBe(200)
  })

  test('repeated alarms: a routine due now, the alarm fired twice back to back, exactly one turn for the slot (slot row and P3\'s history agree)', async ({ request }) => {
    const { id, due } = dueRoutine()
    await Promise.all([alarmAndTick(request), alarmAndTick(request)])
    const slot = await slotWhere(id, 'the slot to end', s => s.state === 'ended')
    expect(slot).toMatchObject({ kind: 'scheduled', local_date: due.date, local_time: due.time, outcome: 'done' })
    expect(slot.slot_key).toBe(`${id}|${due.date}|${due.time}`)
    // Two sources: one slot row, one turn id on it, one turn in the chat's history.
    expect(slotsOf(id)).toHaveLength(1)
    expect(readSql<{ n: number }>('SELECT COUNT(*) AS n FROM routine_slots WHERE turn_id = ?', slot.turn_id!)[0]!.n).toBe(1)
    expect(turnsInChat(slot.chat_id)).toBe(1)

    // Route 33's routine-trace rule: any person reads a routine run's trace; Inhouse needs a grant; a stranger's run id is 404.
    for (const who of [dana, leo, admin]) expect((await call(request, who, 'GET', `/api/traces/${slot.run_id}`)).status, `a person reads the routine's trace`).toBe(200)
    expectError(await call(request, inhouse, 'GET', `/api/traces/${slot.run_id}`), 403, 'forbidden', 'grant_required')
    // A person's own chat trace stays theirs: another Member gets 404 for it.
    const chat = await createChat(request, dana)
    const sent = await send(request, dana, chat, 'scenario:hello a private chat')
    expectError(await call(request, leo, 'GET', `/api/traces/${sent.runId}`), 404, 'not_found')
  })

  test('crash between the slot row and the run: the tick stops after its batch, fired again, exactly one turn', async ({ request }) => {
    const { id } = dueRoutine()
    // Armed right before the pass it is meant for (the 30 s heartbeat can consume an armed switch).
    const armed = await alarmControl(request, { action: 'stopAfterBatch' })
    expect(armed.status, armed.text).toBe(200)
    expect(armed.json).toEqual({ armed: true })
    // The pass that stops throws inside the scheduler (it logs and carries on), so its answer is `{ ran: true }` like any pass: the
    // proof it stopped as designed is the state it left, read before the second pass: the slot row is claimed and nothing ran.
    const stopped = await alarmControl(request, { action: 'alarm', pokeTick: true })
    expect(stopped.status, stopped.text).toBe(200)
    await expect.poll(() => slotsOf(id).length, { timeout: 60_000, message: 'the slot row the first pass wrote' }).toBe(1)
    expect(slotsOf(id)[0], 'the first pass wrote the row and stopped before the run').toMatchObject({ state: 'claimed', run_id: null, turn_id: null })
    expect(readSql('SELECT chat_id FROM routine_slots WHERE routine_id = ?', id).length).toBe(1)
    await alarmAndTick(request)
    const slot = await slotWhere(id, 'the slot to end after the second pass', s => s.state === 'ended')
    expect(slotsOf(id)).toHaveLength(1)
    expect(slot.turn_id).not.toBeNull()
    expect(turnsInChat(slot.chat_id)).toBe(1)
  })

  test('missed run, catch_up within 360 minutes: a routine two hours behind with a slot an hour ago runs once', async ({ request }) => {
    const slotTime = localSlot(60)
    const id = seedRoutine({ creatorId: danaId, hour: slotTime.hour, minute: slotTime.minute, instruction: 'scenario:hello E2E catch up', need: 0, missed: 'catch_up', catchUpWithinMin: 360 })
    const seeded = await alarmControl(request, { action: 'seedCursor', routineId: id, checkedUntilMs: Date.now() - 2 * HOUR })
    expect(seeded.status, seeded.text).toBe(200)
    await alarmAndTick(request)
    const slot = await slotWhere(id, 'the late slot to end', s => s.state === 'ended')
    expect(slot).toMatchObject({ kind: 'scheduled', local_date: slotTime.date, local_time: slotTime.time })
    expect(slotsOf(id)).toHaveLength(1)
    expect(turnsInChat(slot.chat_id)).toBe(1)
  })
})

test.describe('a missed run under skip (acceptance 1)', () => {
  needsLocalD1()
  test.describe.configure({ mode: 'serial' })
  let danaId: string
  test.beforeAll(async ({ request }) => {
    danaId = await memberIdOf(request, dana)
  })
  test.afterAll(() => retireRoutines())

  test('missed run, skip: the same routine runs nothing and leaves a missed row', async ({ request }) => {
    const slotTime = localSlot(60)
    const id = seedRoutine({ creatorId: danaId, hour: slotTime.hour, minute: slotTime.minute, instruction: 'scenario:hello E2E skip', need: 0, missed: 'skip' })
    const seeded = await alarmControl(request, { action: 'seedCursor', routineId: id, checkedUntilMs: Date.now() - 2 * HOUR })
    expect(seeded.status, seeded.text).toBe(200)
    await alarmAndTick(request)
    const slot = await slotWhere(id, 'the missed row', s => s.state === 'missed', 60_000)
    expect(slot).toMatchObject({ kind: 'scheduled', reason: 'late', turn_id: null })
    expect(slotsOf(id)).toHaveLength(1)
    expect(turnsInChat(slot.chat_id)).toBe(0)
  })
})

test.describe('the next run the page shows follows the brand\'s zone', () => {
  needsLocalD1()
  test.describe.configure({ mode: 'serial' })
  let id: string

  test.beforeAll(async ({ request }) => {
    await endLiveGrants(request)
    id = seedRoutine({ creatorId: await memberIdOf(request, dana), hour: 6, minute: 0, instruction: 'scenario:hello E2E zone', need: 0 })
  })
  test.afterAll(async ({ request }) => {
    const done = await putSetting(request, admin, 'brand', 'g:tz', BRAND_TZ)
    expect(done.status, done.text).toBe(200)
    retireRoutines()
  })

  for (const tz of ['America/New_York', 'Europe/London'] as const) {
    test(`${tz}: a daily 06:00 routine's next run is 06:00 there, by the literal offset table`, async ({ request }) => {
      const set = await putSetting(request, admin, 'brand', 'g:tz', tz)
      expect(set.status, set.text).toBe(200)
      const before = Date.now()
      const def = defOf(await list(request, dana), id)!
      const after = Date.now()
      expect([expectedNextDaily(tz, 6, 0, before), expectedNextDaily(tz, 6, 0, after)], `next ${new Date(def.next.ms).toISOString()}`).toContain(def.next.ms)
    })
  }
})
