// Today on the server, end to end over the migrated test D1 (p4-w3.md tests 1b to 5, 8 and 9). The end is W2's real
// `routineEnd`, the reads and writes are the real store and routes. Ways it can fail, written down first:
//  1. delivery order decides what Today shows: the 06:00 slot and a later Run now, delivered either way round and each
//     twice with disjoint items ({a, b} then {a}), must leave only the newer run's items, `b` never back, nothing doubled;
//  2. the end batch fails once after the handler's reads and the retry doubles an item, or loses one;
//  3. a failed turn's output is saved (even when present), or "not connected" rings the bell, or a `complete` claim with no
//     store call counts as complete;
//  4. dismissing one status card hides a later, different one; a snooze or dismissal outlives or undershoots its day;
//  5. a stale `ifRev` overwrites, a role that shouldn't reach route 58 does, Inhouse writes without a grant or without its lines;
//  6. the migration's routine row is missing (an INSERT OR IGNORE that skipped silently) or lets the check run at a stage.
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ToolInfo } from '../../hub/index/contract.ts'
import { accessMatrix } from '../access-matrix.ts'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import { checkAccess } from '../auth/matrix.ts'
import type { Principal } from '../auth/principal.ts'
import { openStores } from '../db/stores.ts'
import { lastLineId, linesSince } from '../db/test-support.ts'
import type { DueTask } from '../do/brand-agent/scheduler.ts'
import type { TurnEndPayload } from '../do/brand-agent/ports.ts'
import { endTaskId } from '../routines/keys.ts'
import { routineEnd } from '../routines/end.ts'
import { routes } from '../routes.ts'
import { intlZone } from '../routines/slots.ts'
import { wrapD1 } from '../routines/test-kit.ts'
import { todayStore } from './store.ts'
import { SYSTEM_ROUTINE_PROMPTS } from '../routines/prompts.ts'

const db = env.DB
const ROUTINE = 'routine-morning-check'
const DAY = '2026-06-01'
const at = (iso: string) => Date.parse(iso)
const NOW = at('2026-06-01T15:00:00Z') // 11:00 on June 1 in New York (the default zone)
const MEMBER = 'm_today_member'
const ADMIN = 'm_today_admin'
const IH = 'm_today_ih'
const GRANT = 'g_todaytest'

const tool = (connector: string): ToolInfo => ({ name: 'orders_list', connector, description: 'x', inputSchema: {} })
const hubWith = (tools: ToolInfo[]) => ({ listTools: async () => ({ ok: true as const, value: tools }) })
const SHOPIFY = hubWith([tool('shopify')])

const item = (key: string, over: Record<string, unknown> = {}) => ({
  key, sev: '#b23c22', area: 'Orders', title: `Title of ${key}`, sub: 'sub', cost: { minor: 100, currency: 'USD' }, costNote: 'at risk', next: 'Do the next thing',
  found: [['Late orders', '4']], sources: [{ n: '#1042', text: 'Placed 9 days ago' }], since: '2026-05-30T09:00:00-04:00', ...over,
})
const result = (keys: string[], over: Record<string, unknown> = {}) => ({ coverage: 'complete', gaps: [], items: keys.map(k => item(k)), ...over })

let n = 0
/** A slot of the morning check: its own turn (with a store call recorded, so a `complete` result stands). A scheduled slot's key is per local date and time, so a second one in a test names its own `time`. */
async function addSlot(over: { state?: string; failure?: string | null; claimed: number; kind?: 'scheduled' | 'manual'; time?: string | null; reason?: string | null; text?: string | null; ended?: number | null; localDate?: string }) {
  const id = ++n
  const kind = over.kind ?? 'scheduled'
  const time = over.time === undefined ? (kind === 'scheduled' ? '06:00' : null) : over.time
  const localDate = over.localDate ?? DAY
  const key = kind === 'scheduled' ? `${ROUTINE}|${localDate}|${time}` : `now|${ROUTINE}|key${String(id).padStart(8, '0')}`
  const turnId = `t_today_${id}`
  await db.prepare(
    `INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, local_time, tz, due_at_ms, deadline_ms, state, reason, chat_id, client_key, prompt_text, submit_json, routine_rev, creator_id, claimed_at_ms, failure, result_text, ended_at_ms, turn_id)
     VALUES (?, ?, ?, ?, ?, 'America/New_York', ?, ?, ?, ?, ?, ?, 'p', '{}', 1, 'm_system', ?, ?, ?, ?, ?)`,
  ).bind(key, ROUTINE, kind, localDate, time, over.claimed, over.claimed + 600_000, over.state ?? 'started', over.reason ?? null, `rc_today${id}`, `rs_today${id}`, over.claimed, over.failure ?? null, over.text ?? null, over.ended ?? null, turnId).run()
  await db.prepare("INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, decision, input_bytes, input_sha256, at_ms) VALUES (?, 0, ?, 'm_system', 'pre', 'mcp__apps__orders_list', 'allow', 1, 'x', 1)").bind(turnId, `rc_today${id}`).run()
  return { key, turnId, runId: `r_today_${id}` }
}

const deliver = (s: { key: string; turnId: string; runId: string }, structured: unknown, nowMs: number, e: Partial<TurnEndPayload> = {}, hub: { listTools: () => Promise<unknown> } = SHOPIFY, d1: D1Database = db) => {
  const payload: TurnEndPayload = { turnId: s.turnId, runId: s.runId, chatId: 'c', outcome: 'done', failure: null, structuredOutput: structured, ...e }
  const task: DueTask = { id: endTaskId(s.key), kind: 'routine-end', gen: 1, dueAtMs: nowMs, payload, attempts: 0 }
  return routineEnd(task, { nowMs, env: { DB: d1, HUB: hub } as unknown as Env })
}

const titles = async (nowMs = NOW) => (await todayStore({ db }).read(nowMs)).items.map(i => i.title)
const rowCount = async () => (await db.prepare('SELECT COUNT(*) AS n FROM today_items').first<number>('n'))!
const slotRow = (key: string) => db.prepare('SELECT state, failure, result_text FROM routine_slots WHERE slot_key = ?').bind(key).first<{ state: string; failure: string | null; result_text: string | null }>()

beforeAll(async () => {
  const m = (id: string, role: string) => db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', ?, 'active', ?, 1)").bind(id, role, `Name of ${id}`)
  await db.batch([
    m(MEMBER, 'member'), m(ADMIN, 'admin'),
    db.prepare("INSERT INTO members (id, kind, status, name, subject, created_at_ms) VALUES (?, 'inhouse', 'active', 'Ian', 's-ih', 1)").bind(IH),
  ])
})
beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM today_aside'), db.prepare('DELETE FROM today_items'), db.prepare('DELETE FROM tool_calls'),
    db.prepare('DELETE FROM routine_slots'), db.prepare('DELETE FROM activity_lines'), db.prepare('DELETE FROM notice_reads'), db.prepare('DELETE FROM notices'), db.prepare('UPDATE routines SET enabled = 1, deleted_at_ms = NULL WHERE id = ?').bind(ROUTINE),
  ])
})

describe('the migration', () => {
  it("makes the system routine row: every day at 06:00, every stage, catch up for six hours, with a prompt ref that has a prompt", async () => {
    const r = await db.prepare('SELECT * FROM routines WHERE id = ?').bind(ROUTINE).first<Record<string, unknown>>()
    expect(r).toMatchObject({
      origin: 'system', kind: 'morning_check', name: 'Morning check', prompt_ref: 'morning-check', days_mask: 127, hour: 6, minute: 0, missed: 'catch_up',
      catch_up_within_min: 360, need: 0, enabled: 1, creator_id: 'm_system', rev: 1,
    })
    expect(r!.checked_until_ms).toBeGreaterThan(1_700_000_000_000)
    expect(Object.hasOwn(SYSTEM_ROUTINE_PROMPTS, r!.prompt_ref as string)).toBe(true)
  })
})

describe('order, not delivery', () => {
  const orders: [string, (a: () => Promise<unknown>, b: () => Promise<unknown>) => Promise<void>][] = [
    ['the 06:00 result first', async (a, b) => { await a(); await b() }],
    ['the Run now result first', async (a, b) => { await b(); await a() }],
    ['each twice, interleaved', async (a, b) => { await a(); await b(); await a(); await b() }],
    ['each twice, the newer first', async (a, b) => { await b(); await a(); await b(); await a() }],
  ]
  for (const [name, run] of orders) {
    it(`${name}: Today shows the newer run's items only`, async () => {
      const morning = await addSlot({ claimed: at('2026-06-01T10:00:00Z') })
      const manual = await addSlot({ claimed: at('2026-06-01T14:00:00Z'), kind: 'manual' })
      await run(
        () => deliver(morning, result(['a', 'b']), at('2026-06-01T10:03:00Z')),
        () => deliver(manual, result(['a']), at('2026-06-01T14:02:00Z')),
      )
      expect(await titles()).toEqual(['Title of a'])
      // `a` is one row, reported by the newer slot; `b` stays stored under the older slot and is never listed.
      expect(await rowCount()).toBe(2)
      expect((await db.prepare('SELECT slot_key FROM today_items WHERE key = ?').bind('a').first<string>('slot_key'))).toBe(manual.key)
    })
  }

  it('a manual run with no scheduled slot that day fills Today', async () => {
    const manual = await addSlot({ claimed: at('2026-06-01T14:00:00Z'), kind: 'manual' })
    await deliver(manual, result(['a', 'b']), at('2026-06-01T14:02:00Z'))
    expect(await titles()).toEqual(['Title of a', 'Title of b'])
  })

  it('saves the item with its fixed fields: id from key and date, the run as its trace, since parsed, a bad since null', async () => {
    const s = await addSlot({ claimed: at('2026-06-01T10:00:00Z') })
    await deliver(s, { coverage: 'complete', gaps: [], items: [item('a'), item('b', { since: 'last Tuesday' })] }, at('2026-06-01T10:03:00Z'))
    const rows = (await db.prepare('SELECT id, key, local_date, run_id, item_json FROM today_items ORDER BY rowid').all<{ id: string; key: string; local_date: string; run_id: string; item_json: string }>()).results
    expect(rows.map(r => [r.key, r.local_date, r.run_id])).toEqual([['a', DAY, s.runId], ['b', DAY, s.runId]])
    const [a, b] = rows.map(r => JSON.parse(r.item_json))
    expect(a).toMatchObject({ id: rows[0].id, routineRun: s.runId, since: { iso: '2026-05-30T13:00:00.000Z', ms: at('2026-05-30T13:00:00Z') }, foundAt: { ms: at('2026-06-01T10:03:00Z') } })
    expect(b.since).toBeNull()
    expect(await slotRow(s.key)).toEqual({ state: 'ended', failure: null, result_text: 'found 2 things' })
  })

  it('writes its Activity line (the slot\'s, once) and one bell notice for the team (once, whatever the deliveries)', async () => {
    const s = await addSlot({ claimed: at('2026-06-01T10:00:00Z') })
    await deliver(s, result(['a', 'b']), at('2026-06-01T10:03:00Z'))
    await deliver(s, result(['a', 'b']), at('2026-06-01T10:04:00Z'))
    const lines = (await db.prepare("SELECT template, fields_json, trace FROM activity_lines WHERE source = 'routine-slot' AND source_key = ?").bind(s.key).all<{ template: string; fields_json: string; trace: string }>()).results
    expect(lines).toEqual([{ template: 'morning_check_ran', fields_json: '{"items":2}', trace: s.runId }])
    const notices = (await db.prepare("SELECT audience, template, fields_json, link_json FROM notices WHERE template = 'morning_check_found' AND id LIKE 'mc_%'").all<{ audience: string; fields_json: string; link_json: string }>()).results
    expect(notices.filter(x => x.fields_json === '{"items":2}')).toEqual([{ audience: 'team', template: 'morning_check_found', fields_json: '{"items":2}', link_json: '{"to":"page","page":"today"}' }])
  })

  it('zero items: complete, no notice, an empty list', async () => {
    const before = (await db.prepare("SELECT COUNT(*) AS n FROM notices WHERE template = 'morning_check_found'").first<number>('n'))!
    const s = await addSlot({ claimed: at('2026-06-01T10:00:00Z') })
    await deliver(s, result([]), at('2026-06-01T10:03:00Z'))
    expect((await slotRow(s.key))?.result_text).toBe('found 0 things')
    expect(await titles()).toEqual([])
    expect((await db.prepare("SELECT COUNT(*) AS n FROM notices WHERE template = 'morning_check_found'").first<number>('n'))!).toBe(before)
  })
})

describe('partial failure', () => {
  it('an end batch that fails once after the handler\'s reads, re-delivered, leaves each item exactly once', async () => {
    const s = await addSlot({ claimed: at('2026-06-01T10:00:00Z') })
    let failed = false
    const wrapped = wrapD1(db, async kind => {
      if (kind === 'batch' && !failed) {
        failed = true
        throw new Error('the batch failed once')
      }
    })
    await expect(deliver(s, result(['a', 'b']), at('2026-06-01T10:03:00Z'), {}, SHOPIFY, wrapped.db)).rejects.toThrow('the batch failed once')
    expect(await rowCount()).toBe(0)
    expect((await slotRow(s.key))?.state).toBe('started')
    await deliver(s, result(['a', 'b']), at('2026-06-01T10:04:00Z'), {}, SHOPIFY, wrapped.db)
    expect(await rowCount()).toBe(2)
    expect(await titles()).toEqual(['Title of a', 'Title of b'])
  })
})

describe('what is never saved', () => {
  it('a failed turn\'s structured output, present or not, saves nothing and says run_failed', async () => {
    for (const e of [{ outcome: 'failed' as const, failure: 'structured_output' }, { outcome: 'stopped' as const }, { outcome: 'interrupted' as const }, { outcome: 'cancelled' as const, failure: 'pause' }]) {
      const s = await addSlot({ claimed: at('2026-06-01T10:00:00Z') + n, kind: 'manual' })
      await deliver(s, result(['a']), at('2026-06-01T10:03:00Z'), e)
      expect(await rowCount()).toBe(0)
      const row = await slotRow(s.key)
      expect(row?.state).toBe('ended')
      expect(row?.failure).toBe(e.failure ?? 'run_failed')
      expect(row?.result_text).toBe("didn't finish")
    }
  })

  it('a clean end with no structured output is run_failed', async () => {
    const s = await addSlot({ claimed: at('2026-06-01T10:00:00Z') })
    await deliver(s, null, at('2026-06-01T10:03:00Z'))
    expect((await slotRow(s.key))?.failure).toBe('run_failed')
  })

  it('a structurally wrong result saves nothing and says invalid_result; a cosmetic overrun still saves', async () => {
    const wrong = await addSlot({ claimed: at('2026-06-01T10:00:00Z') })
    await deliver(wrong, { coverage: 'complete', gaps: [], items: [item('a', { cost: { minor: 1.5, currency: 'USD' } })] }, at('2026-06-01T10:03:00Z'))
    expect(await rowCount()).toBe(0)
    expect((await slotRow(wrong.key))?.failure).toBe('invalid_result')
    const long = await addSlot({ claimed: at('2026-06-01T11:00:00Z'), kind: 'manual' })
    await deliver(long, result(['a'], { items: [item('a', { title: 'x'.repeat(130) })] }), at('2026-06-01T11:03:00Z'))
    expect(await titles()).toEqual([`${'x'.repeat(119)}…`])
  })

  it('a currency that is not the brand\'s is invalid_result', async () => {
    const s = await addSlot({ claimed: at('2026-06-01T10:00:00Z') })
    await deliver(s, { coverage: 'complete', gaps: [], items: [item('a', { cost: { minor: 1, currency: 'GBP' } })] }, at('2026-06-01T10:03:00Z'))
    expect((await slotRow(s.key))?.failure).toBe('invalid_result')
  })

  it('no store connected (an empty tool list, or not_configured): no statements, a quiet failure and no bell for it', async () => {
    const bell = async () => (await db.prepare("SELECT COUNT(*) AS n FROM notices WHERE template IN ('routine_failed', 'morning_check_found')").first<number>('n'))!
    const before = await bell()
    for (const hub of [hubWith([]), hubWith([tool('other')]), { listTools: async () => ({ ok: false as const, error: { code: 'not_configured', message: 'x' } }) }]) {
      const s = await addSlot({ claimed: at('2026-06-01T10:00:00Z') + n, kind: 'manual' })
      await deliver(s, result(['a']), at('2026-06-01T10:03:00Z'), {}, hub)
      expect(await rowCount()).toBe(0)
      expect(await slotRow(s.key)).toEqual({ state: 'ended', failure: 'not_connected', result_text: "Shopify isn't connected" })
    }
    expect(await bell()).toBe(before)
  })

  it('any other hub error throws, so the end is retried and no wrong cause is recorded', async () => {
    const s = await addSlot({ claimed: at('2026-06-01T10:00:00Z') })
    await expect(deliver(s, result(['a']), at('2026-06-01T10:03:00Z'), {}, { listTools: async () => ({ ok: false, error: { code: 'upstream_unavailable', message: 'x' } }) })).rejects.toThrow('upstream_unavailable')
    expect((await slotRow(s.key))?.state).toBe('started')
  })
})

describe('the coverage backstop and incomplete runs', () => {
  it('a complete result from a turn with no store call saves as incomplete with all five gaps (items kept)', async () => {
    const s = await addSlot({ claimed: at('2026-06-01T10:00:00Z') })
    await db.prepare('DELETE FROM tool_calls WHERE turn_id = ?').bind(s.turnId).run()
    await db.prepare("INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, decision, input_bytes, input_sha256, at_ms) VALUES (?, 0, 'c', 'm_system', 'pre', 'mcp__inhouse__memory_search', 'allow', 1, 'x', 1)").bind(s.turnId).run()
    await deliver(s, result(['a']), at('2026-06-01T10:03:00Z'))
    expect(await slotRow(s.key)).toEqual({ state: 'ended', failure: 'incomplete', result_text: "found 1 thing; couldn't read orders, products, inventory, refunds, returns" })
    expect(await titles()).toContain('Title of a')
  })

  it('an incomplete result: items saved, the gap named, a card beside the items, and the admins told', async () => {
    const s = await addSlot({ claimed: at('2026-06-01T10:00:00Z') })
    await deliver(s, result(['a'], { coverage: 'incomplete', gaps: ['refunds'] }), at('2026-06-01T10:03:00Z'))
    expect(await slotRow(s.key)).toEqual({ state: 'ended', failure: 'incomplete', result_text: "found 1 thing; couldn't read refunds" })
    expect(await titles()).toEqual(['Title of a', "The 6:00 AM check couldn't read everything: refunds"])
    const adminNotice = await db.prepare("SELECT COUNT(*) AS n FROM notices WHERE template = 'routine_failed' AND audience = 'admins' AND fields_json = ?").bind('{"code":"incomplete"}').first<number>('n')
    expect(adminNotice).toBeGreaterThanOrEqual(1)
  })

  it('11 items: 10 shown, a card says so', async () => {
    const s = await addSlot({ claimed: at('2026-06-01T10:00:00Z') })
    await deliver(s, result(Array.from({ length: 11 }, (_, i) => `k-${i}`)), at('2026-06-01T10:03:00Z'))
    const shown = await titles()
    expect(shown).toHaveLength(11)
    expect(shown.at(-1)).toBe('The 6:00 AM check found more than 10 things; showing 10')
    expect((await slotRow(s.key))?.result_text).toBe('found more than 10 things; showing 10')
  })

  it('dismissing an incomplete card leaves a later failed card of the same day visible', async () => {
    const first = await addSlot({ claimed: at('2026-06-01T10:00:00Z') })
    await deliver(first, result(['a'], { coverage: 'incomplete', gaps: ['refunds'] }), at('2026-06-01T10:03:00Z'))
    const store = todayStore({ db })
    const incompleteId = (await store.read(NOW)).items.find(i => i.id.startsWith('p_check_') && i.id.includes('_incomplete_'))!.id
    expect('ok' in (await store.setAside({ id: incompleteId, reason: 'dismissed', ifRev: 0 }, { actorId: MEMBER, requestId: 'r1', nowMs: NOW }))).toBe(true)
    expect(await titles()).toEqual(['Title of a'])
    const second = await addSlot({ claimed: at('2026-06-01T12:00:00Z'), kind: 'manual' })
    await deliver(second, null, at('2026-06-01T12:02:00Z'), { outcome: 'failed', failure: 'session_crashed' })
    const after = await titles()
    expect(after).toEqual(['Title of a', "The 8:02 AM check didn't finish"])
  })
})

describe('set aside', () => {
  const store = () => todayStore({ db })
  const w = (id: string, reason: 'snoozed' | 'dismissed' | null, ifRev: number, nowMs = NOW) => store().setAside({ id, reason, ifRev }, { actorId: MEMBER, requestId: `req-${Math.random()}`, nowMs })
  const seed = async () => {
    const s = await addSlot({ claimed: at('2026-06-01T10:00:00Z') })
    await deliver(s, result(['a', 'b']), at('2026-06-01T10:03:00Z'))
    return (await db.prepare('SELECT id, key FROM today_items ORDER BY rowid').all<{ id: string; key: string }>()).results
  }

  it('a snooze at 23:50 comes back after local midnight; a dismissal stays through a second run that day; a new date shows the problem again', async () => {
    const [a, b] = await seed()
    const snoozedAt = at('2026-06-02T03:50:00Z') // 23:50 June 1 in New York
    expect('ok' in await w(a.id, 'snoozed', 0, snoozedAt)).toBe(true)
    expect('ok' in await w(b.id, 'dismissed', 0, snoozedAt)).toBe(true)
    // 23:55 June 1: both hidden.
    expect(await titles(at('2026-06-02T03:55:00Z'))).toEqual([])
    // A second run the same local day (a Run now): the same ids, still hidden.
    const manual = await addSlot({ claimed: at('2026-06-02T03:56:00Z'), kind: 'manual' })
    await deliver(manual, result(['a', 'b']), at('2026-06-02T03:57:00Z'))
    expect(await titles(at('2026-06-02T03:58:00Z'))).toEqual([])
    // Just after local midnight: the next local day has no run yet, so yesterday's list stands with the snoozed one back and the dismissed one still gone... and a card says today's check hasn't run once it is past 06:10.
    expect(await titles(at('2026-06-02T04:05:00Z'))).toEqual(['Title of a'])
    // Next morning's run: the same problem key on a new local date has a new id, so a dismissed problem comes back.
    const next = await addSlot({ claimed: at('2026-06-02T10:00:00Z'), localDate: '2026-06-02' })
    await deliver(next, result(['a', 'b']), at('2026-06-02T10:03:00Z'))
    expect(await titles(at('2026-06-02T12:00:00Z'))).toEqual(['Title of a', 'Title of b'])
  })

  it('an unknown id is not found; a first write over an existing row and a stale ifRev conflict with the current record; Undo keeps the row', async () => {
    const [a] = await seed()
    expect(await w('p_AAAAAAAAAAAAAAAAAAAAAA', 'dismissed', 0)).toEqual({ refused: 'not_found' })
    const first = await w(a.id, 'snoozed', 0)
    expect(first).toMatchObject({ ok: { reason: 'snoozed', rev: 1, by: MEMBER } })
    const again = await w(a.id, 'dismissed', 0)
    expect(again).toMatchObject({ conflict: { reason: 'snoozed', rev: 1 } })
    const stale = await w(a.id, 'dismissed', 5)
    expect(stale).toMatchObject({ conflict: { rev: 1 } })
    expect(await w(a.id, 'dismissed', 1)).toMatchObject({ ok: { reason: 'dismissed', rev: 2 } })
    expect(await w(a.id, null, 2)).toMatchObject({ ok: { reason: null, rev: 3 } })
    expect(await titles()).toEqual(['Title of a', 'Title of b'])
    // The record stays (reason null) so the client's next write has its rev.
    expect((await store().read(NOW)).aside[a.id]).toMatchObject({ reason: null, rev: 3 })
    expect(await w(a.id, 'snoozed', 3)).toMatchObject({ ok: { rev: 4 } })
  })

  it('writes its audit line and its Activity line in the write\'s batch (a set-aside, not an Undo)', async () => {
    const [a] = await seed()
    const before = await lastLineId(db)
    const activityBefore = (await db.prepare('SELECT COALESCE(MAX(n), 0) AS n FROM activity_lines').first<number>('n'))!
    await w(a.id, 'dismissed', 0)
    await w(a.id, null, 1)
    const lines = await linesSince(db, before)
    expect(lines.map(l => [l.action, l.actor_id, JSON.parse(l.args_json)])).toEqual([
      ['today.set_aside', MEMBER, { itemId: a.id, reason: 'dismissed' }],
      ['today.set_aside', MEMBER, { itemId: a.id, reason: null }],
    ])
    const activity = (await db.prepare("SELECT template, actor_id, source_key FROM activity_lines WHERE source = 'today-aside' AND n > ?").bind(activityBefore).all<{ template: string; actor_id: string; source_key: string }>()).results
    expect(activity).toEqual([{ template: 'today_set_aside', actor_id: MEMBER, source_key: `${a.id}|1` }])
  })

  it('a conflicting write writes no audit line and no Activity line', async () => {
    const [a] = await seed()
    await w(a.id, 'snoozed', 0)
    const before = await lastLineId(db)
    const linesBefore = (await db.prepare("SELECT COUNT(*) AS n FROM activity_lines WHERE source = 'today-aside'").first<number>('n'))!
    await w(a.id, 'dismissed', 0)
    expect(await linesSince(db, before)).toEqual([])
    expect((await db.prepare("SELECT COUNT(*) AS n FROM activity_lines WHERE source = 'today-aside'").first<number>('n'))!).toBe(linesBefore)
  })
})

describe('the routes (rows 57 and 58), every role', () => {
  const person = (memberId: string, role: 'member' | 'admin'): Principal => ({ kind: 'person', memberId, role, subject: `s-${memberId}`, requestId: `req-${Math.random()}`, expMs: Date.now() + 600_000 })
  const inhouse = (live: boolean): Principal => ({ kind: 'inhouse', memberId: IH, subject: 's-ih', grant: live ? { id: GRANT, endsAtMs: Date.now() + 60_000 } : null, requestId: `req-${Math.random()}`, expMs: Date.now() + 600_000 })
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
  async function send(principal: Principal, method: 'GET' | 'PUT', path: string, body?: unknown) {
    const parts: ApiParts = { authenticate: async () => ({ principal }), checkOrigin: () => null, checkAccess, stores: e => openStores(e), routes, accessMatrix }
    const res = await api(parts, new Request(`http://brand.localhost:8787${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'Content-Type': 'application/json', Origin: 'http://brand.localhost:8787' },
    }), env, ctx, 'req-test')
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const seedOne = async () => {
    const claimed = Date.now() - 1000
    const s = await addSlot({ claimed, kind: 'manual', localDate: intlZone('America/New_York')(claimed).date })
    await deliver(s, result(['a']), Date.now())
    return (await db.prepare('SELECT id FROM today_items').first<string>('id'))!
  }

  it('members, Admins and Inhouse under a live grant read Today; Inhouse without a grant is refused', async () => {
    for (const p of [person(MEMBER, 'member'), person(ADMIN, 'admin'), inhouse(true)]) {
      const r = await send(p, 'GET', '/api/today')
      expect(r.status).toBe(200)
      expect(Object.keys(r.body).sort()).toEqual(['aside', 'items'])
    }
    expect(await send(inhouse(false), 'GET', '/api/today')).toEqual({ status: 403, body: { error: { code: 'forbidden', reason: 'grant_required' } } })
  })

  it('every role that may write sets an item aside; Inhouse writes only under a live grant, with its support.access line', async () => {
    const id = await seedOne()
    expect((await send(person(MEMBER, 'member'), 'PUT', `/api/today/${id}/aside`, { reason: 'snoozed', ifRev: 0 })).status).toBe(200)
    expect((await send(person(ADMIN, 'admin'), 'PUT', `/api/today/${id}/aside`, { reason: 'dismissed', ifRev: 1 })).status).toBe(200)
    expect((await send(inhouse(false), 'PUT', `/api/today/${id}/aside`, { reason: 'dismissed', ifRev: 2 })).status).toBe(403)
    const before = await lastLineId(db)
    const done = await send(inhouse(true), 'PUT', `/api/today/${id}/aside`, { reason: null, ifRev: 2 })
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ reason: null, rev: 3, by: IH })
    expect((await linesSince(db, before)).map(l => [l.action, JSON.parse(l.args_json)])).toEqual([
      ['support.access', { grantId: GRANT, method: 'PUT', route: '/api/today/:id/aside' }],
      ['today.set_aside', { itemId: id, reason: null }],
    ])
  })

  it('refuses a bad id (404), a bad body or `declined` (400), a stale ifRev (409 with the current record) and an unknown id (404)', async () => {
    const id = await seedOne()
    const p = person(MEMBER, 'member')
    expect((await send(p, 'PUT', '/api/today/not-an-id/aside', { reason: 'snoozed', ifRev: 0 })).status).toBe(404)
    for (const body of [{}, { reason: 'declined', ifRev: 0 }, { reason: 'snoozed' }, { reason: 'snoozed', ifRev: -1 }, { reason: 'snoozed', ifRev: 0, extra: 1 }, { reason: 'snoozed', ifRev: 1.5 }]) {
      expect((await send(p, 'PUT', `/api/today/${id}/aside`, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await send(p, 'PUT', '/api/today/p_AAAAAAAAAAAAAAAAAAAAAA/aside', { reason: 'snoozed', ifRev: 0 })).status).toBe(404)
    await send(p, 'PUT', `/api/today/${id}/aside`, { reason: 'snoozed', ifRev: 0 })
    const stale = await send(p, 'PUT', `/api/today/${id}/aside`, { reason: 'dismissed', ifRev: 0 })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ error: { code: 'conflict', current: { reason: 'snoozed', rev: 1 } } })
    expect((await send(p, 'GET', '/api/today?x=1')).status).toBe(400)
  })

  it('the answer lists the records of every card, set aside or not, and leaves the set aside ones out of items', async () => {
    const id = await seedOne()
    const p = person(MEMBER, 'member')
    await send(p, 'PUT', `/api/today/${id}/aside`, { reason: 'dismissed', ifRev: 0 })
    const r = await send(p, 'GET', '/api/today')
    expect((r.body.items as unknown[])).toEqual([])
    expect(r.body.aside).toMatchObject({ [id]: { reason: 'dismissed', rev: 1, by: MEMBER } })
  })
})
