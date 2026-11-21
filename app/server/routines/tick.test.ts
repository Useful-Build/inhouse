// The routine tick on literal timelines (p4-w2.md tests 5 to 8, 13, 15, 16 and the refusal rules of section 4). A real
// D1 (the migrated test D1), the reference fake of `runs.submit` (test-kit.ts) and an injected clock. Ways it can fail,
// written down first: a late slot runs under `skip`, or more than the newest runs under `catch_up`; a zone change runs a
// local date twice; a routine's turn runs as a person; a removed creator stops a routine; a team routine runs at Watch;
// a drain spins the alarm or starves rows; a slot waiting on a question is closed as lost or opens a second Run now; a
// submit goes into a trashed chat; a transient refusal ends a row, a final one doesn't, or `key_reused` is taken as final.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SYSTEM_ROUTINE_DESCRIPTIONS, SYSTEM_ROUTINE_PROMPTS } from './prompts.ts'
import { routinesSignal } from './signal.ts'
import { runNow } from './store.ts'
import { POKE_ID, TICK_ID } from './tick.ts'
import { MIN, addPerson, at, db, fresh, harness, insertRoutine, linesOf, routine, setStage, setZone, slotsOf } from './test-kit.ts'

const CREATOR = 'm_w2_tick_creator'
// 2026-06-01 is a Monday; New York is on EDT (06:00 local = 10:00Z).
const D1 = '2026-06-01'
const six = (date: string) => at(`${date}T10:00:00Z`)

beforeAll(async () => {
  await addPerson(CREATOR)
  ;(SYSTEM_ROUTINE_PROMPTS as Record<string, string>)['test-system-check'] = 'Run the test system check.'
  ;(SYSTEM_ROUTINE_DESCRIPTIONS as Record<string, string>)['test-system-check'] = 'A test system routine.'
})
beforeEach(async () => {
  await fresh()
  await setZone('America/New_York')
  await setStage('Act')
})

describe('missed rules (test 5)', () => {
  it('an outage from 05:50 to 09:00 under skip: the 06:00 slot is missed, nothing runs', async () => {
    const h = harness()
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - 10 * MIN }))
    await h.tick(six(D1) + 180 * MIN)
    expect((await slotsOf(r.id)).map(s => [s.slot_key, s.state, s.reason])).toEqual([[`${r.id}|${D1}|06:00`, 'missed', 'late']])
    expect(h.runs.turns.size).toBe(0)
    expect((await linesOf(r.id)).map(l => [l.template, l.source_key])).toEqual([['routine_missed', `${r.id}|${D1}|06:00|missed`]])
  })

  it('the same outage under catch_up within 360 minutes: one run at 09:00', async () => {
    const h = harness()
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - 10 * MIN, missed: 'catch_up' }))
    await h.tick(six(D1) + 180 * MIN)
    const [s] = await slotsOf(r.id)
    expect([s.state, s.deadline_ms]).toEqual(['started', six(D1) + 360 * MIN])
    expect(h.runs.turns.size).toBe(1)
  })

  it('three missed days under catch_up: only the newest within the window runs, the older ones are missed', async () => {
    const h = harness()
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - 10 * MIN, missed: 'catch_up' }))
    await h.tick(six('2026-06-03') + 180 * MIN)
    expect((await slotsOf(r.id)).map(s => [s.local_date, s.state])).toEqual([['2026-06-01', 'missed'], ['2026-06-02', 'missed'], ['2026-06-03', 'started']])
    expect(h.runs.turns.size).toBe(1)
  })

  it('a late alarm at 06:08 is on time and runs', async () => {
    const h = harness()
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - 10 * MIN }))
    await h.tick(six(D1) + 8 * MIN)
    expect((await slotsOf(r.id)).map(s => s.state)).toEqual(['started'])
    expect(h.runs.turns.size).toBe(1)
  })

  it('a claimed row left by a pool outage until 09:30 under skip is closed missed, never run', async () => {
    const h = harness()
    h.runs.refuse = () => ({ refused: { code: 'unavailable', reason: 'pool_full' } })
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - 10 * MIN }))
    await h.tick(six(D1))
    expect((await slotsOf(r.id)).map(s => s.state)).toEqual(['claimed'])
    h.runs.refuse = undefined
    await h.tick(six(D1) + 210 * MIN)
    expect((await slotsOf(r.id)).map(s => [s.state, s.reason])).toEqual([['missed', 'late']])
    expect(h.runs.turns.size).toBe(0)
  })

  it('a transient rate_limited refusal at 06:00, then success at 06:05: it runs once', async () => {
    const h = harness()
    h.runs.refuse = () => ({ refused: { code: 'rate_limited' } })
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - 10 * MIN }))
    await h.tick(six(D1))
    expect((await slotsOf(r.id))[0]).toMatchObject({ state: 'claimed', next_attempt_ms: six(D1) + 30_000 })
    h.runs.refuse = undefined
    await h.tick(six(D1) + 5 * MIN)
    await h.tick(six(D1) + 6 * MIN)
    expect((await slotsOf(r.id)).map(s => s.state)).toEqual(['started'])
    expect(h.runs.turns.size).toBe(1)
  })
})

describe('refusals and failures (section 4, step 3)', () => {
  it('paused is final: refused, reason paused', async () => {
    const h = harness()
    h.runs.refuse = () => ({ refused: { code: 'forbidden', reason: 'paused' } })
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - MIN }))
    await h.tick(six(D1))
    expect((await slotsOf(r.id)).map(s => [s.state, s.reason])).toEqual([['refused', 'paused']])
  })

  it('cap_reached and any unnamed code are final; the code is the reason', async () => {
    for (const [refused, reason] of [[{ code: 'cap_reached' }, 'cap_reached'], [{ code: 'invalid' }, 'invalid']] as const) {
      await fresh()
      const h = harness()
      h.runs.refuse = () => ({ refused })
      const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - MIN }))
      await h.tick(six(D1))
      expect((await slotsOf(r.id)).map(s => [s.state, s.reason])).toEqual([['refused', reason]])
    }
  })

  it('key_reused is an invariant break: the row stays claimed, an alarm is counted and the signal goes red', async () => {
    const h = harness()
    h.runs.refuse = () => ({ refused: { code: 'conflict', reason: 'key_reused' } })
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - MIN }))
    await h.tick(six(D1))
    expect((await slotsOf(r.id)).map(s => s.state)).toEqual(['claimed'])
    expect(await db.prepare("SELECT count FROM routine_alerts WHERE code = 'key_reused'").first('count')).toBe(1)
    expect((await routinesSignal(db, six(D1))).ok).toBe(false)
  })

  it('three thrown submits make the row refused, reason internal; each waits 30 s', async () => {
    const h = harness()
    h.runs.refuse = () => {
      throw new Error('boom')
    }
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - MIN }))
    await h.tick(six(D1))
    await h.tick(six(D1) + 10_000) // not yet due again
    expect((await slotsOf(r.id))[0]).toMatchObject({ state: 'claimed', submit_failures: 1 })
    await h.tick(six(D1) + 30_000)
    await h.tick(six(D1) + 60_000)
    expect((await slotsOf(r.id)).map(s => [s.state, s.reason, s.submit_failures])).toEqual([['refused', 'internal', 3]])
    expect(h.runs.calls).toBe(3)
  })
})

describe('zone change (test 6)', () => {
  it('a 06:00 slot ran under London; the zone moves to New York at 08:00 London: no second run that local date', async () => {
    await setZone('Europe/London')
    const h = harness()
    const londonSix = at(`${D1}T05:00:00Z`) // 06:00 BST
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: londonSix - MIN }))
    await h.tick(londonSix)
    await setZone('America/New_York')
    await h.tick(at(`${D1}T07:00:00Z`))
    await h.tick(six(D1)) // 06:00 in New York, the same local date
    expect((await slotsOf(r.id)).map(s => [s.slot_key, s.tz])).toEqual([[`${r.id}|${D1}|06:00`, 'Europe/London']])
    expect(h.runs.turns.size).toBe(1)
  })
})

describe('the routine principal (test 7, OC 1)', () => {
  it('submits as m_system; the creator is only on the slot row; a removed creator leaves the next slot running', async () => {
    const creator = await addPerson('m_w2_tick_leaver')
    const h = harness()
    const r = await insertRoutine(routine({ creator_id: creator, checked_until_ms: six(D1) - MIN }))
    await h.tick(six(D1))
    const [turn] = h.runs.turns.values()
    expect(turn.submit.by).toEqual({ kind: 'service', memberId: 'm_system' })
    expect(JSON.stringify(turn.submit)).not.toContain(creator)
    expect((await slotsOf(r.id))[0].creator_id).toBe(creator)
    expect(await db.prepare('SELECT owner_id FROM chats WHERE id = ?').bind(turn.chatId).first('owner_id')).toBe('m_system')
    await h.end(turn, six(D1) + 5 * MIN)
    await db.prepare("UPDATE members SET status = 'removed' WHERE id = ?").bind(creator).run()
    await h.tick(six('2026-06-02'))
    expect((await slotsOf(r.id)).map(s => s.state)).toEqual(['ended', 'started'])
    expect(h.runs.turns.size).toBe(2)
  })
})

describe('stage (test 8)', () => {
  it('at Watch a team routine slot is skipped (stage), the system routine runs', async () => {
    await setStage('Watch')
    const h = harness()
    const team = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - MIN }))
    const sys = await insertRoutine(routine({
      id: 'routine-test-check', origin: 'system', kind: 'agent', prompt_ref: 'test-system-check', need: 0, creator_id: 'm_system', checked_until_ms: six(D1) - MIN,
    }))
    await h.tick(six(D1))
    expect((await slotsOf(team.id)).map(s => [s.state, s.reason])).toEqual([['skipped', 'stage']])
    expect((await slotsOf(sys.id)).map(s => s.state)).toEqual(['started'])
    expect([...h.runs.turns.values()].map(t => t.submit.input.text)).toEqual(['Run the test system check.'])
  })

  it('a stage drop between decision and submit skips the claimed row', async () => {
    const h = harness()
    h.runs.refuse = () => ({ refused: { code: 'unavailable', reason: 'draining' } })
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - MIN }))
    await h.tick(six(D1))
    await setStage('Watch')
    h.runs.refuse = undefined
    await h.tick(six(D1) + MIN)
    expect((await slotsOf(r.id)).map(s => [s.state, s.reason])).toEqual([['skipped', 'stage']])
    expect(h.runs.turns.size).toBe(0)
  })
})

describe('the heartbeat and the poke (section 4, steps 0 and 4)', () => {
  it('the heartbeat re-arms (early for the next slot); a poke never schedules the heartbeat', async () => {
    const h = harness()
    await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - 10 * MIN }))
    await h.tick(six(D1) - 3 * MIN, POKE_ID)
    expect(h.scheduler.scheduled).toEqual([])
    await h.tick(six(D1) - 3 * MIN, TICK_ID)
    expect(h.scheduler.scheduled.map(s => s.dueAtMs)).toEqual([six(D1) + 2 * MIN, six(D1)])
  })
})

describe('a drain (test 13)', () => {
  it('25 claimed rows answered draining for 3 minutes: passes are bounded, no row starves, each runs once after', async () => {
    const h = harness()
    const ids: string[] = []
    for (let i = 0; i < 25; i++) ids.push((await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - 10 * MIN }))).id)
    const liftAt = six(D1) + 3 * MIN
    let now = six(D1)
    h.runs.refuse = () => (now < liftAt ? { refused: { code: 'unavailable', reason: 'draining' } } : undefined)
    let passes = 0
    const attemptedBeforeLift = new Set<string>()
    h.runs.afterSubmit = undefined
    const origSubmit = h.runs.submit.bind(h.runs)
    h.runs.submit = async t => {
      if (now < liftAt) attemptedBeforeLift.add(t.chatId)
      return origSubmit(t)
    }
    while (now < liftAt) {
      await h.tick(now)
      passes++
      const next = h.scheduler.heartbeatAt()!
      expect(next).toBeGreaterThanOrEqual(now)
      now = next
    }
    // At most one pass per 30 s, plus the first pass's immediate re-run and the heartbeat.
    expect(passes).toBeLessThanOrEqual(3 * 2 + 2)
    expect(attemptedBeforeLift.size).toBe(25)
    for (let i = 0; i < 3; i++) {
      await h.tick(now)
      now = Math.max(h.scheduler.heartbeatAt()!, now + 1)
    }
    for (const id of ids) expect((await slotsOf(id)).map(s => s.state), id).toEqual(['started'])
    expect(h.runs.turns.size).toBe(25)
  })
})

describe('a routine that asks a question (test 15, section 6b)', () => {
  it('waits past 45 minutes, opens no second Run now, writes nothing; then ends once at the resume', async () => {
    const h = harness()
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) }))
    const t0 = six(D1) + 60 * MIN
    expect('ok' in await runNow(db, r.id, 'clientkey-one', { actorId: CREATOR, requestId: 'req-q1', nowMs: t0 })).toBe(true)
    await h.tick(t0)
    const [turn] = h.runs.turns.values()
    h.status.set(turn.chatId, { waiting: true, liveRunId: null })
    await h.tick(t0 + 46 * MIN)
    expect((await slotsOf(r.id)).map(s => s.state)).toEqual(['started'])
    expect(await linesOf(r.id)).toEqual([])
    expect((await routinesSignal(db, t0 + 46 * MIN)).ok).toBe(true)
    expect('conflict' in await runNow(db, r.id, 'clientkey-two', { actorId: CREATOR, requestId: 'req-q2', nowMs: t0 + 47 * MIN })).toBe(true)
    // The resume ends: one end, the slot ended once.
    h.status.set(turn.chatId, { waiting: false, liveRunId: null })
    await h.end(turn, t0 + 3 * 24 * 60 * MIN, { outcome: 'done', structuredOutput: { found: 2 } })
    await h.end(turn, t0 + 3 * 24 * 60 * MIN + MIN)
    expect((await slotsOf(r.id)).map(s => [s.state, s.outcome])).toEqual([['ended', 'done']])
    expect((await linesOf(r.id)).map(l => l.template)).toEqual(['routine_ran'])
  })

  it('a resumed turn running past 45 minutes (chat live) is not closed', async () => {
    const h = harness()
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - MIN }))
    await h.tick(six(D1))
    const [turn] = h.runs.turns.values()
    h.status.set(turn.chatId, { waiting: false, liveRunId: 'r_live' })
    await h.tick(six(D1) + 50 * MIN)
    expect((await slotsOf(r.id))[0].state).toBe('started')
    h.status.delete(turn.chatId)
    await h.tick(six(D1) + 51 * MIN)
    expect((await slotsOf(r.id)).map(s => [s.state, s.reason])).toEqual([['lost', 'no_end']])
  })

  it('backstop: still waiting at 8 days plus a minute is lost (timeout); a late end still moves it to ended', async () => {
    const h = harness()
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - MIN, enabled: 1 }))
    await h.tick(six(D1))
    await db.prepare('UPDATE routines SET enabled = 0 WHERE id = ?').bind(r.id).run() // no more slots meanwhile
    const [turn] = h.runs.turns.values()
    h.status.set(turn.chatId, { waiting: true, liveRunId: null })
    const late = six(D1) + 8 * 24 * 60 * MIN + MIN
    await h.tick(late)
    expect((await slotsOf(r.id)).map(s => [s.state, s.reason])).toEqual([['lost', 'timeout']])
    await h.end(turn, late + MIN, { outcome: 'cancelled', failure: 'expired' })
    expect((await slotsOf(r.id)).map(s => [s.state, s.failure])).toEqual([['ended', 'expired']])
    expect((await linesOf(r.id)).map(l => l.source_key.split('|').at(-1))).toEqual(['lost', '06:00'])
  })
})

describe('a soft-deleted chat (test 16)', () => {
  it('a claimed slot whose chat is in the trash is skipped (chat_deleted), never submitted; the next slot runs in its own chat', async () => {
    const h = harness()
    h.runs.refuse = () => ({ refused: { code: 'unavailable', reason: 'draining' } })
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - MIN }))
    await h.tick(six(D1)) // ensureChat made the chat; the submit was refused
    const [first] = await slotsOf(r.id)
    await db.prepare('UPDATE chats SET deleted_at_ms = ? WHERE id = ?').bind(six(D1) + MIN, first.chat_id).run()
    h.runs.refuse = undefined
    const callsBefore = h.runs.calls
    await h.tick(six(D1) + 2 * MIN)
    expect((await slotsOf(r.id)).map(s => [s.state, s.reason])).toEqual([['skipped', 'chat_deleted']])
    expect(h.runs.calls).toBe(callsBefore)
    await h.tick(six('2026-06-02'))
    const slots = await slotsOf(r.id)
    expect(slots.map(s => s.state)).toEqual(['skipped', 'started'])
    expect(slots[1].chat_id).not.toBe(first.chat_id)
  })
})

describe('the sweep past waiting rows (#250 review)', () => {
  it('51 started rows waiting on a question don\'t starve a newer overdue one, nor stop the pass early', async () => {
    const h = harness()
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1), enabled: 0 }))
    const insert = (key: string, chat: string, startedAt: number) => db.prepare(
      `INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, local_time, tz, due_at_ms, deadline_ms, state, chat_id, client_key,
          prompt_text, submit_json, routine_rev, creator_id, claimed_at_ms, started_at_ms, run_id)
        VALUES (?, ?, 'scheduled', ?, '06:00', 'America/New_York', ?, ?, 'started', ?, 'rs_key', 'x', '{}', 1, ?, ?, ?, 'r_AAAAAAAAAAAAAAAAAAAAAA')`,
    ).bind(key, r.id, D1, startedAt, startedAt + 10 * MIN, chat, CREATOR, startedAt, startedAt)
    const stmts = []
    for (let i = 0; i < 51; i++) {
      const chat = `rc_wait_${String(i).padStart(2, '0')}`
      stmts.push(insert(`${r.id}|${D1}|wait-${String(i).padStart(2, '0')}`, chat, six(D1) + i * 1000))
      h.status.set(chat, { waiting: true, liveRunId: null })
    }
    stmts.push(insert(`${r.id}|${D1}|overdue`, 'rc_overdue', six(D1) + 60_000))
    await db.batch(stmts)
    const now = six(D1) + 2 * 60 * MIN
    await h.tick(now)
    const overdue = await db.prepare('SELECT state, reason FROM routine_slots WHERE slot_key = ?').bind(`${r.id}|${D1}|overdue`).first()
    expect(overdue).toEqual({ state: 'lost', reason: 'no_end' })
    expect(await db.prepare("SELECT COUNT(*) AS n FROM routine_slots WHERE state = 'started'").first('n')).toBe(51)
    // Not stopped early: the heartbeat isn't re-armed at now.
    expect(h.scheduler.heartbeatAt()).toBeGreaterThan(now)
  })
})

describe('guarded lines (#250 review)', () => {
  it('a decide batch that lost its gate inserts no row and writes no missed line', async () => {
    const { wrapD1 } = await import('./test-kit.ts')
    const h = harness()
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: six(D1) - 10 * MIN }))
    // A route write lands right before the pass's first batch (the decide batch): rev moves on.
    const w = wrapD1(db, async (kind) => {
      if (kind === 'batch') await db.prepare('UPDATE routines SET rev = rev + 1 WHERE id = ? AND rev = 1').bind(r.id).run()
    })
    await h.tick(six(D1) + 180 * MIN, undefined, w.db)
    expect(await slotsOf(r.id)).toEqual([])
    expect(await linesOf(r.id)).toEqual([])
  })
})
