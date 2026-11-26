// The routine tools (p4-w2.md sections 7 and 8; tests 8 and 9), called through the composed handler map the `inhouse`
// server serves. Ways it can fail, written down first: a team routine is made at Watch; a routine's own run (`m_system`)
// makes, changes, deletes or runs a routine; another member changes or deletes a routine they didn't make; an Admin
// can't; an Activity line or an audit line carries a routine's name or instruction; one person sees another's source
// chat; a schedule edit backfills; on/off isn't its own audit line.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { TOOL_HANDLERS } from '../index.ts'
import type { ToolResult, ToolScope } from '../../server/tool.ts'
import { addPerson, at, db, fresh, insertRoutine, routine, setStage, setZone, slotsOf } from '../../../routines/test-kit.ts'

const ALEX = 'm_w2_tools_alex'
const SAM = 'm_w2_tools_sam'
const ADMIN = 'm_w2_tools_admin'
const NOW = at('2026-06-01T12:00:00Z')
const NAME = 'Zebra stock watch'
const INSTRUCTION = 'Check the zebra-striped socks and tell me what is low.'

let n = 0
const scope = (memberId: string, over: Partial<ToolScope> = {}): ToolScope => ({
  memberId, chatId: `c_tools_${memberId}`, runId: 'r_AAAAAAAAAAAAAAAAAAAAAA', turnId: `t_${String(++n).padStart(22, 'A')}`, nowMs: NOW, requestId: `req-tools-${n}`, ...over,
})
async function call(name: string, args: Record<string, unknown>, s: ToolScope): Promise<ToolResult> {
  const h = TOOL_HANDLERS.get(name)!
  const parsed = h.input.safeParse(args)
  if (!parsed.success) throw new Error(`${name}: ${parsed.error.message}`)
  return h.call(parsed.data, s, { db })
}
const text = (r: ToolResult) => r.content[0].text
const data = (r: ToolResult) => r.structuredContent as Record<string, unknown>

async function create(by = ALEX, over: Record<string, unknown> = {}): Promise<string> {
  const r = await call('routine_create', { name: NAME, instruction: INSTRUCTION, days: 'weekdays', time: '06:00', ...over }, scope(by))
  expect(r.isError, text(r)).toBeUndefined()
  return data(r).routine_id as string
}
/** A routine's own lines (Activity is append-only, so earlier tests' lines stay: told apart by the routine id). */
const lines = async (routineId: string) =>
  (await db.prepare("SELECT template, actor_id, fields_json, source_key FROM activity_lines WHERE source = 'routine' AND source_key LIKE ? ORDER BY at_ms, source_key").bind(`${routineId}|%`).all<Record<string, string>>()).results
const audit = async (routineId: string) =>
  (await db.prepare("SELECT actor_id, action, target_kind, target_id, args_json FROM audit_log WHERE target_id = ? ORDER BY id").bind(routineId).all<Record<string, string>>()).results

beforeAll(async () => {
  await addPerson(ALEX)
  await addPerson(SAM)
  await addPerson(ADMIN, 'admin')
})
beforeEach(async () => {
  await fresh()
  await setZone('America/New_York')
  await setStage('Act')
})

describe('legacy stage settings do not gate routines', () => {
  it('routine_create works with Watch stored and preserves the legacy need column', async () => {
    await setStage('Watch')
    const id = await create()
    expect(await db.prepare('SELECT COUNT(*) AS n FROM routines').first('n')).toBe(1)
    expect(await db.prepare('SELECT origin, need, missed, creator_id, source_chat_id, checked_until_ms, days_mask FROM routines WHERE id = ?').bind(id).first())
      .toEqual({ origin: 'team', need: 1, missed: 'skip', creator_id: ALEX, source_chat_id: `c_tools_${ALEX}`, checked_until_ms: NOW, days_mask: 31 })
  })
})

describe('the routine tools (test 9)', () => {
  it('the server still serves exactly the 21 tools (P6a added skill_save), the five routine ones built', () => {
    expect(TOOL_HANDLERS.size).toBe(21)
    for (const name of ['routine_create', 'routine_list', 'routine_update', 'routine_delete', 'routine_run_now']) {
      expect(TOOL_HANDLERS.get(name)!.input.safeParse({ anything: 1 }).success, name).toBe(false)
    }
  })

  it('create answers the id, the next run and the schedule in words; Activity and audit carry no name or text', async () => {
    const r = await call('routine_create', { name: NAME, instruction: INSTRUCTION, days: ['mon', 'thu'], time: '07:30', missed: 'catch_up' }, scope(ALEX))
    const id = data(r).routine_id as string
    expect(id).toMatch(/^rt_[A-Za-z0-9_-]{22}$/)
    // 2026-06-01 is a Monday; 07:30 EDT is 11:30Z, already past at 12:00Z: the next is Thursday.
    expect(data(r)).toMatchObject({ schedule: 'Mondays and Thursdays at 07:30', next: '2026-06-04T11:30:00.000Z' })
    expect(await lines(id)).toEqual([{ template: 'routine_made', actor_id: ALEX, fields_json: '{}', source_key: `${id}|created` }])
    expect(await audit(id)).toEqual([{ actor_id: ALEX, action: 'routine.created', target_kind: 'routine', target_id: id, args_json: '{"routineId":"' + id + '"}' }])
    const everything = JSON.stringify([await lines(id), await audit(id)])
    expect(everything).not.toContain('Zebra')
    expect(everything).not.toContain('zebra')
  })

  it('a routine run (m_system) may list but never create, change, delete or run one', async () => {
    const id = await create()
    const sys = scope('m_system', { chatId: 'rc_routinechat' })
    for (const [name, args] of [
      ['routine_create', { name: 'x', instruction: 'y', days: 'daily', time: '01:00' }],
      ['routine_update', { routine_id: id, enabled: false }],
      ['routine_delete', { routine_id: id }],
      ['routine_run_now', { routine_id: id }],
    ] as const) {
      const r = await call(name, args, sys)
      expect([r.isError, data(r).error], name).toEqual([true, 'forbidden'])
    }
    const listed = await call('routine_list', {}, sys)
    expect((data(listed).routines as unknown[]).length).toBe(1)
    expect(await db.prepare('SELECT rev, enabled, deleted_at_ms FROM routines WHERE id = ?').bind(id).first()).toEqual({ rev: 1, enabled: 1, deleted_at_ms: null })
    expect(await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'routine.%' AND actor_id = 'm_system'").first('n')).toBe(0)
  })

  it('another member can neither change nor delete it; an Admin can', async () => {
    const id = await create()
    for (const [name, args] of [['routine_update', { routine_id: id, time: '08:00' }], ['routine_delete', { routine_id: id }]] as const) {
      const r = await call(name, args, scope(SAM))
      expect([r.isError, text(r)], name).toEqual([true, 'Only the person who set it up or an admin can change it'])
    }
    expect(await db.prepare('SELECT rev, hour FROM routines WHERE id = ?').bind(id).first()).toEqual({ rev: 1, hour: 6 })
    const u = await call('routine_update', { routine_id: id, time: '08:00', enabled: false }, scope(ADMIN))
    expect(u.isError).toBeUndefined()
    const d = await call('routine_delete', { routine_id: id }, scope(ADMIN))
    expect(d.isError).toBeUndefined()
    expect((await audit(id)).map(a => [a.actor_id, a.action, a.args_json])).toEqual([
      [ALEX, 'routine.created', `{"routineId":"${id}"}`],
      [ADMIN, 'routine.updated', `{"routineId":"${id}","changed":["schedule"]}`],
      [ADMIN, 'routine.enabled', `{"routineId":"${id}","on":false}`],
      [ADMIN, 'routine.deleted', `{"routineId":"${id}"}`],
    ])
    expect((await lines(id)).map(l => [l.template, l.actor_id])).toEqual([['routine_made', ALEX], ['routine_changed', ADMIN], ['routine_deleted', ADMIN]])
    const listed = await call('routine_list', {}, scope(ALEX))
    expect(data(listed).routines).toEqual([])
  })

  it('a schedule edit moves the cursor to now (no backfill)', async () => {
    const id = await create()
    await db.prepare('UPDATE routines SET checked_until_ms = ? WHERE id = ?').bind(NOW - 3 * 86_400_000, id).run()
    await call('routine_update', { routine_id: id, days: 'daily' }, scope(ALEX, { nowMs: NOW + 1000 }))
    expect(await db.prepare('SELECT checked_until_ms, days_mask, rev FROM routines WHERE id = ?').bind(id).first()).toEqual({ checked_until_ms: NOW + 1000, days_mask: 127, rev: 2 })
  })

  it('routine_list shows the source chat only to the person who made it, newest first, 20 a page', async () => {
    const ids: string[] = []
    for (let i = 0; i < 21; i++) ids.push(await create(ALEX))
    // Newest first by creation time: give each its own.
    for (const [i, id] of ids.entries()) await db.prepare('UPDATE routines SET created_at_ms = ? WHERE id = ?').bind(NOW + i, id).run()
    const mine = await call('routine_list', {}, scope(ALEX))
    const theirs = await call('routine_list', {}, scope(SAM))
    const first = (data(mine).routines as Record<string, unknown>[])
    expect(first.map(r => r.routine_id)).toEqual(ids.slice(1).reverse())
    expect(first[0]).toMatchObject({ source_chat_id: `c_tools_${ALEX}`, schedule: 'Weekdays at 06:00', enabled: true, last: null })
    expect((data(theirs).routines as Record<string, unknown>[]).some(r => 'source_chat_id' in r)).toBe(false)
    const next = await call('routine_list', { cursor: data(mine).next_cursor }, scope(ALEX))
    expect((data(next).routines as Record<string, unknown>[]).map(r => r.routine_id)).toEqual([ids[0]])
    expect(data(next).next_cursor).toBeNull()
  })

  it('routine_run_now: one claimed manual row per turn, a second open one is run_open; a disabled routine may run', async () => {
    const id = await create()
    await call('routine_update', { routine_id: id, enabled: false }, scope(ALEX))
    const s = scope(ALEX)
    const a = await call('routine_run_now', { routine_id: id }, s)
    const again = await call('routine_run_now', { routine_id: id }, s)
    expect(a.isError).toBeUndefined()
    expect(data(again).run).toBe(data(a).run)
    const other = await call('routine_run_now', { routine_id: id }, scope(SAM))
    expect([other.isError, text(other)]).toEqual([true, 'A run is still going. Try again when it finishes.'])
    const slots = await slotsOf(id)
    expect(slots.map(x => [x.kind, x.state, x.requested_by, x.local_time, x.deadline_ms - x.due_at_ms])).toEqual([['manual', 'claimed', ALEX, null, 600_000]])
    expect((await audit(id)).filter(l => l.action === 'routine.run_now').map(l => l.actor_id)).toEqual([ALEX])
  })

  it('routine_run_now works with Watch stored, but a deleted routine is not found', async () => {
    const id = await create()
    await setStage('Watch')
    const r = await call('routine_run_now', { routine_id: id }, scope(ALEX))
    expect(r.isError).toBeUndefined()
    expect((await slotsOf(id)).map(s => s.state)).toEqual(['claimed'])
    await call('routine_delete', { routine_id: id }, scope(ALEX))
    const d = await call('routine_run_now', { routine_id: id }, scope(ALEX))
    expect([d.isError, data(d).error]).toEqual([true, 'not_found'])
  })
})

describe('what a routine run reads (test 7, acceptance 6)', () => {
  it('memory_search returns brand facts only; history_search and history_read return routine chats only', async () => {
    const fact = (id: string, scope: 'brand' | 'person', owner: string | null, t: string) =>
      db.prepare("INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'active', ?, 0, 0)")
        .bind(id, scope, owner, t, owner ?? ALEX)
    const chat = (id: string, owner: string) => db.prepare('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, ?, 0, 0)').bind(id, owner, 'A chat')
    const msg = (id: string, chatId: string, t: string) =>
      db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, text, at_ms) VALUES (?, ?, 'r_AAAAAAAAAAAAAAAAAAAAAA', 't_AAAAAAAAAAAAAAAAAAAAAA', 0, 'user', ?, 0)").bind(id, chatId, t)
    await db.batch([
      fact('mem_w2_brand', 'brand', null, 'The parrot shipments go out on Tuesdays'),
      fact('mem_w2_alex', 'person', ALEX, 'Alex likes parrot reports short'),
      fact('mem_w2_sam', 'person', SAM, 'Sam wants parrot numbers in a table'),
      chat('c_w2_alex', ALEX), chat('c_w2_sam', SAM), chat('rc_w2_routine', 'm_system'),
      msg('t_AAAAAAAAAAAAAAAAAAAAA1.u', 'c_w2_alex', 'parrot stock question from Alex'),
      msg('t_AAAAAAAAAAAAAAAAAAAAA2.u', 'c_w2_sam', 'parrot stock question from Sam'),
      msg('t_AAAAAAAAAAAAAAAAAAAAA3.u', 'rc_w2_routine', 'parrot stock check by the routine'),
    ])
    const sys = scope('m_system', { chatId: 'rc_w2_now' })
    const facts = data(await call('memory_search', { query: 'parrot' }, sys)).facts as { memory_id: string }[]
    expect(facts.map(f => f.memory_id)).toEqual(['mem_w2_brand'])
    const hits = data(await call('history_search', { query: 'parrot' }, sys))
    expect(JSON.stringify(hits)).toContain('rc_w2_routine')
    expect(JSON.stringify(hits)).not.toMatch(/c_w2_alex|c_w2_sam/)
    for (const chatId of ['c_w2_alex', 'c_w2_sam']) {
      expect((await call('history_read', { chat_id: chatId }, sys)).isError, chatId).toBe(true)
    }
    expect((await call('history_read', { chat_id: 'rc_w2_routine' }, sys)).isError).toBeUndefined()
  })
})

describe('no read after a committed write (#250 review)', () => {
  it('a settings read that fails once the write committed can\'t turn a committed create or update into isError', async () => {
    // Every settings read after the first batch throws, as a transient D1 failure would.
    let committed = false
    const flaky = {
      prepare: (q: string) => {
        if (committed && /FROM settings/.test(q)) throw new Error('D1 is unavailable')
        return db.prepare(q)
      },
      batch: async (stmts: D1PreparedStatement[]) => {
        const out = await db.batch(stmts)
        committed = true
        return out
      },
    } as unknown as D1Database
    const h = TOOL_HANDLERS.get('routine_create')!
    const made = await h.call(h.input.parse({ name: NAME, instruction: INSTRUCTION, days: 'daily', time: '06:00' }), scope(ALEX), { db: flaky })
    expect(made.isError, text(made)).toBeUndefined()
    expect(await db.prepare('SELECT COUNT(*) AS n FROM routines').first('n')).toBe(1)

    committed = false
    const u = TOOL_HANDLERS.get('routine_update')!
    const updated = await u.call(u.input.parse({ routine_id: data(made).routine_id, time: '07:00' }), scope(ALEX), { db: flaky })
    expect(updated.isError, text(updated)).toBeUndefined()
    expect(data(updated)).toMatchObject({ schedule: 'Every day at 07:00' })
  })
})

// #312 review M2 and L3: what the agent is told when the cap is reached, or when it tries to rewrite a system routine.
describe('refusals the agent can explain (#312 review)', () => {
  it('routine_create past 50 live team routines is refused with routine_limit and what to do', async () => {
    for (let i = 0; i < 50; i++) await create()
    const r = await call('routine_create', { name: NAME, instruction: INSTRUCTION, days: 'daily', time: '06:00' }, scope(ALEX))
    expect([r.isError, data(r).error, text(r)]).toEqual([true, 'routine_limit', 'This brand already has 50 routines, the most it can have. Delete one on the Routines page, then try again.'])
  })
  it('routine_update with an instruction for a system routine is refused; a schedule edit still works', async () => {
    const sys = await insertRoutine(routine({ origin: 'system', kind: 'morning_check', prompt_ref: 'morning-check', need: 0, creator_id: 'm_system', checked_until_ms: NOW }))
    const r = await call('routine_update', { routine_id: sys.id, instruction: 'Do something else.' }, scope(ADMIN))
    expect([r.isError, data(r).error, text(r)]).toEqual([true, 'system_instruction', "This routine is built in, so its instructions can't be changed. Its schedule and on/off can."])
    expect(await audit(sys.id)).toEqual([])
    const ok = await call('routine_update', { routine_id: sys.id, time: '07:00' }, scope(ADMIN))
    expect(ok.isError, text(ok)).toBeUndefined()
  })
})
