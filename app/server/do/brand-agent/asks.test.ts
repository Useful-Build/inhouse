// BrandAgent's side of the ask flow (Stage 1 M2-D, N14) on the engine's real SQLite and the test D1. Ways it can fail,
// written down first:
//  1. admission lets through a helper's call, a call with no audit record (or one from a runner below v4), the same
//     invocation with other arguments, a denied call, a call after the turn was fenced, a paused brand or a removed
//     member; or a replay of a used call makes a new action instead of returning the same one;
//  2. the turn's `ask` part is added twice, or after the turn ended; `action.updated` is missed for a new revision;
//  3. a turn holds a fourth wait, or a wait starts on a turn that isn't live;
//  4. a turn that ended any way but `done` leaves its `tool` rows; one that ended `done` loses them;
//  5. a resume turn goes out with another key, without `source: 'action'`, while the texts port is null, or into a
//     deleted chat; a refused submit is lost instead of tried again with the same key;
//  6. the D1 report store changes a row it shouldn't (another `from`), or anything but `report`.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { auditInputSha256 } from '../../../shared/protocol/index.ts'
import type { AuditEntry } from '../../../shared/protocol/index.ts'
import { d1Chat, ev, inAgent, settle } from '../../testing/brand-agent/core-harness.ts'
import type { Harness } from '../../testing/brand-agent/core-harness.ts'
import { ASKER, fresh, outbox, requestCtx, rowOf, tagArgs, world } from '../../outbox/test-support.ts'
import { Asks, d1Reports, DELIVER_KIND, deliverTaskId, MAX_WAITS_PER_TURN, resumeKey } from './asks.ts'
import type { ActionTexts, AsksDeps } from './asks.ts'
import { ACTIONS_TOOL_PREFIX, recordInvocation } from './invocations.ts'

const db = env.DB
const TOOL = `${ACTIONS_TOOL_PREFIX}shopify_order_tag_add`
const SETTINGS = { model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium' as const, sideModel: 'claude-haiku-5-5', maxTurns: 25, webFetchDomains: [], webSearch: false }
const TEXTS: ActionTexts = { result: p => `An automatic note from Inhouse: ${p.title} is ${p.state}.` }

const asks = (h: Harness, deps: Partial<AsksDeps> = {}) =>
  new Asks({ sql: h.sql, scheduler: h.sched, db, core: h.core, deps: { texts: null, settings: async () => SETTINGS, ...deps }, now: () => h.clock.now })

const entry = async (o: Partial<AuditEntry> & { args?: unknown } = {}): Promise<AuditEntry> => {
  const { args = tagArgs(1), ...rest } = o
  return { hook: 'PreToolUse', toolName: TOOL, toolUseId: fresh('toolu'), decision: 'allow', input: args, agentId: null, inputSha256: await auditInputSha256(args), ...rest }
}

/** A live turn of `ASKER`'s chat. */
async function liveTurn(h: Harness, chat = `c_asks_${fresh('c')}`): Promise<{ turnId: string; chat: string }> {
  await d1Chat(chat, ASKER)
  const a = await h.submit(chat, `key-${fresh('k').replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 60), { member: ASKER })
  if ('refused' in a) throw new Error(`submit refused: ${JSON.stringify(a)}`)
  await settle()
  expect(h.turn(a.turnId).state).toBe('live')
  return { turnId: a.turnId, chat }
}

beforeEach(async () => {
  await world(db)
})

describe('admission (failure 1)', () => {
  it('a recorded main-agent call with this input is admitted once; the same call again answers the same invocation', () => inAgent(async h => {
    const { turnId, chat } = await liveTurn(h)
    const e = await entry()
    expect(recordInvocation(h.sql, turnId, e, h.clock.now)).toBe(true)
    const a = asks(h).admit(turnId, TOOL, e.inputSha256!)
    expect(a).toEqual({ toolUseId: e.toolUseId, turnId, runId: h.turn(turnId).run_id, chatId: chat, ownerId: ASKER, jobId: null, replay: false })
    expect(asks(h).admit(turnId, TOOL, e.inputSha256!)).toEqual({ ...a, replay: true })
    // Two calls with the same input: two invocations, each admitted once, oldest first.
    const e2 = await entry()
    recordInvocation(h.sql, turnId, e2, h.clock.now + 1)
    expect(asks(h).admit(turnId, TOOL, e.inputSha256!)).toMatchObject({ toolUseId: e2.toolUseId, replay: false })
  }))

  it('refuses a helper\'s call, an unrecorded call, other arguments, another tool, a denied call and a v3 entry', () => inAgent(async h => {
    const { turnId } = await liveTurn(h)
    const helper = await entry({ agentId: 'agent_researcher_1' })
    const denied = await entry({ decision: 'deny' })
    const { agentId: _a, inputSha256: _s, ...v3 } = await entry({ args: tagArgs(9) })
    recordInvocation(h.sql, turnId, helper, h.clock.now)
    recordInvocation(h.sql, turnId, denied, h.clock.now)
    expect(recordInvocation(h.sql, turnId, v3 as AuditEntry, h.clock.now)).toBe(false)
    expect(recordInvocation(h.sql, turnId, await entry({ toolName: 'mcp__apps__orders_search' }), h.clock.now)).toBe(false)
    const a = asks(h)
    expect(a.admit(turnId, TOOL, helper.inputSha256!)).toEqual({ refused: 'no_match' })
    expect(a.admit(turnId, TOOL, denied.inputSha256!)).toEqual({ refused: 'no_match' })
    expect(a.admit(turnId, TOOL, await auditInputSha256(tagArgs(9)))).toEqual({ refused: 'no_match' })
    const mine = await entry({ args: tagArgs(3) })
    recordInvocation(h.sql, turnId, mine, h.clock.now)
    expect(a.admit(turnId, TOOL, await auditInputSha256(tagArgs(4)))).toEqual({ refused: 'no_match' })
    expect(a.admit(turnId, 'mcp__actions__slack_channel_post', mine.inputSha256!)).toEqual({ refused: 'no_match' })
    expect(a.admit(turnId, 'mcp__apps__orders_search', mine.inputSha256!)).toEqual({ refused: 'no_match' })
    // Still unused: the refusals took nothing.
    expect(a.admit(turnId, TOOL, mine.inputSha256!)).toMatchObject({ toolUseId: mine.toolUseId, replay: false })
  }))

  it('refuses after the turn was fenced, while the brand is paused, and once the member is removed', () => inAgent(async h => {
    const fenced = await liveTurn(h)
    const e1 = await entry()
    recordInvocation(h.sql, fenced.turnId, e1, h.clock.now)
    h.core.stop(fenced.turnId, { kind: 'person', memberId: ASKER })
    expect(asks(h).admit(fenced.turnId, TOOL, e1.inputSha256!)).toEqual({ refused: 'turn_not_live' })
    expect(asks(h).admit('t_unknown', TOOL, e1.inputSha256!)).toEqual({ refused: 'turn_not_live' })

    const removed = await liveTurn(h)
    const e2 = await entry()
    recordInvocation(h.sql, removed.turnId, e2, h.clock.now)
    h.sql.exec("INSERT INTO authority (kind, id, at_ms) VALUES ('member', ?, 0)", ASKER)
    expect(asks(h).admit(removed.turnId, TOOL, e2.inputSha256!)).toEqual({ refused: 'member_removed' })
    h.sql.exec("DELETE FROM authority WHERE kind = 'member' AND id = ?", ASKER)

    h.sql.exec("INSERT INTO flags (key, value) VALUES ('paused_at_ms', 1) ON CONFLICT (key) DO UPDATE SET value = 1")
    expect(asks(h).admit(removed.turnId, TOOL, e2.inputSha256!)).toEqual({ refused: 'paused' })
  }))
})

/** A waiting action of this turn, made through the outbox with the turn's invocation. */
async function action(h: Harness, turnId: string, chat: string, order = 1) {
  const r = await outbox(db, () => h.clock.now).request(
    requestCtx({ nowMs: h.clock.now, chatId: chat, invocation: { runId: h.turn(turnId).run_id, turnId, toolUseId: fresh('toolu') } }),
    { operation: 'shopify.order.tag_add', args: tagArgs(order) }, { mode: 'tool' },
  )
  if (r.outcome === 'refused') throw new Error(r.reason)
  return r.action.id
}

const eventsOf = (h: Harness, turnId: string) => h.events(h.turn(turnId).run_id)

describe('the chat: the ask part and action.updated (failure 2)', () => {
  it('adds the turn\'s ask part once per action, and none once the turn has ended', () => inAgent(async h => {
    const { turnId, chat } = await liveTurn(h)
    const id = await action(h, turnId, chat)
    expect(asks(h).noted(turnId, id)).toBe(true)
    expect(asks(h).noted(turnId, id)).toBe(false)
    const parts = eventsOf(h, turnId).filter(e => e.type === 'part' && e.part.type === 'ask')
    expect(parts).toEqual([expect.objectContaining({ type: 'part', turnId, messageId: `${turnId}.0`, part: { type: 'ask', actionId: id } })])
    expect(h.turn(turnId).parts_n).toBe(1)
    h.push(turnId, ev.started(), ev.success(), ev.released(null, false))
    await settle()
    const later = await action(h, turnId, chat, 2)
    expect(asks(h).noted(turnId, later)).toBe(false)
    expect(eventsOf(h, turnId).filter(e => e.type === 'part' && e.part.type === 'ask')).toHaveLength(1)
  }))

  it('the deliver task emits action.updated for each new revision, once', () => inAgent(async h => {
    const { turnId, chat } = await liveTurn(h)
    const id = await action(h, turnId, chat)
    await asks(h).deliver(id)
    await asks(h).deliver(id)
    const row = (await rowOf(db, id))!
    const updates = () => eventsOf(h, turnId).filter(e => e.type === 'action.updated')
    expect(updates()).toEqual([expect.objectContaining({ type: 'action.updated', actionId: id, rev: row.rev, state: 'waiting' })])
    await outbox(db, () => h.clock.now).answer({ memberId: ASKER, role: 'member' }, id, { choice: 'deny', ifRev: row.rev })
    await asks(h).deliver(id)
    expect(updates().map(e => e.type === 'action.updated' && e.state)).toEqual(['waiting', 'denied'])
  }))

  it('changed() schedules the deliver task now', () => inAgent(async h => {
    asks(h).changed('ac_xxxxxxxxxxxxxxxxxxxxxx')
    expect(h.dueTasks()).toContainEqual(expect.objectContaining({ id: deliverTaskId('ac_xxxxxxxxxxxxxxxxxxxxxx'), due_at_ms: h.clock.now }))
    expect(DELIVER_KIND).toBe('action-deliver')
  }))
})

describe('waits (failure 3)', () => {
  it('at most 3 live waits per turn, one per action, only on a live turn; a finished wait frees its place', () => inAgent(async h => {
    const { turnId } = await liveTurn(h)
    const a = asks(h)
    for (let i = 0; i < MAX_WAITS_PER_TURN; i++) expect(a.beginWait(turnId, `ac_w${i}`)).toMatchObject({ wait: true })
    expect(a.beginWait(turnId, 'ac_w3')).toEqual({ wait: false, why: 'busy' })
    a.endWait('ac_w0', false)
    // A second waiter on a live wait's action: not `busy` (that would hand its report on), `already_waiting`.
    expect(a.beginWait(turnId, 'ac_w1')).toEqual({ wait: false, why: 'already_waiting' })
    expect(a.beginWait(turnId, 'ac_w3')).toMatchObject({ wait: true })
    expect(a.beginWait('t_unknown', 'ac_w9')).toEqual({ wait: false, why: 'turn_not_live' })
    h.core.stop(turnId, { kind: 'person', memberId: ASKER })
    expect(a.beginWait(turnId, 'ac_w8')).toEqual({ wait: false, why: 'turn_not_live' })
  }))
})

describe('the turn\'s end and the resume turn (failures 4, 5)', () => {
  /** A turn with one admitted call and its action, its report claimed by the waiter (`tool`), settled `sent`. */
  async function claimed(h: Harness) {
    const t = await liveTurn(h)
    const e = await entry()
    recordInvocation(h.sql, t.turnId, e, h.clock.now)
    expect(asks(h).admit(t.turnId, TOOL, e.inputSha256!)).toMatchObject({ replay: false })
    const id = await action(h, t.turnId, t.chat)
    expect(await d1Reports(db).set(id, 'tool', [null])).toBe(true)
    await db.prepare("UPDATE outbox_actions SET state = 'sent', result_json = '{\"ref\":\"vip\"}' WHERE id = ?").bind(id).run()
    return { ...t, id }
  }

  it('a turn that fails flips its tool rows to later, and with the texts port on, one resume turn goes out with key act_<id>', () => inAgent(async h => {
    const { turnId, chat, id } = await claimed(h)
    const a = asks(h, { texts: TEXTS })
    h.core.addFinalHook(t => a.onTurnFinal(t))
    h.push(turnId, ev.started(), ev.finished('error_during_execution'), ev.released({ mainEntries: 2, lastUuid: 'u2', lastUuidIndex: 1 }))
    await settle()
    expect(h.turn(turnId)).toMatchObject({ state: 'ended', outcome: 'failed' })
    expect(h.dueTasks()).toContainEqual(expect.objectContaining({ id: `ask-turn-end:${turnId}` }))
    await a.turnEnded(turnId)
    expect((await rowOf(db, id))!.report).toBe('later')
    await a.deliver(id)
    await a.deliver(id)
    expect((await rowOf(db, id))!.report).toBe('resume')
    const resumes = h.turns().filter(t => t.chat_id === chat && t.source === 'action')
    expect(resumes.map(t => [t.client_key, t.owner_id, t.priority, t.text])).toEqual([[resumeKey(id), ASKER, 'next', 'An automatic note from Inhouse: Add a tag to order 1 is sent.']])
    // The chat says whose words these are: the server's, for an action (`turn.queued`'s source).
    const queued = h.events(resumes[0]!.run_id).filter(e => e.type === 'turn.queued' && e.turnId === resumes[0]!.turn_id)
    expect(queued).toEqual([expect.objectContaining({ type: 'turn.queued', source: 'action', by: ASKER })])
  }))

  it('a turn that ends done keeps its tool rows: the waiter told the agent', () => inAgent(async h => {
    const { turnId, id } = await claimed(h)
    const a = asks(h, { texts: TEXTS })
    h.sql.exec('INSERT INTO ask_waits (action_id, turn_id, started_at_ms, until_ms, finished, delivered) VALUES (?, ?, ?, ?, 1, 1)', id, turnId, h.clock.now, h.clock.now + 1)
    h.push(turnId, ...[ev.started(), ev.text('done'), ev.checkpoint(2, 'u2', 1), ev.success(), ev.released({ mainEntries: 2, lastUuid: 'u2', lastUuidIndex: 1 })])
    await settle()
    await a.turnEnded(turnId)
    await a.deliver(id)
    expect((await rowOf(db, id))!.report).toBe('tool')
    expect(h.turns().filter(t => t.source === 'action')).toEqual([])
  }))

  it('the texts port off: nothing is submitted, the report waits for M2-G', () => inAgent(async h => {
    const { turnId, id } = await claimed(h)
    h.core.stop(turnId, { kind: 'person', memberId: ASKER })
    await settle()
    await asks(h).turnEnded(turnId)
    await asks(h).deliver(id)
    expect((await rowOf(db, id))!.report).toBe('later')
    expect(h.turns().filter(t => t.source === 'action')).toEqual([])
  }))

  it('a deleted chat gets none: no turn goes in', () => inAgent(async h => {
    const { turnId, chat, id } = await claimed(h)
    h.core.stop(turnId, { kind: 'person', memberId: ASKER })
    await settle()
    await d1Chat(chat, ASKER, 1)
    const a = asks(h, { texts: TEXTS })
    await a.turnEnded(turnId)
    await a.deliver(id)
    expect((await rowOf(db, id))!.report).toBe('none')
    expect(h.turns().filter(t => t.source === 'action')).toEqual([])
  }))

  it('a refused submit (paused) is tried again later with the same key, and then goes in once', () => inAgent(async h => {
    const { turnId, chat, id } = await claimed(h)
    h.core.stop(turnId, { kind: 'person', memberId: ASKER })
    await settle()
    const a = asks(h, { texts: TEXTS })
    await a.turnEnded(turnId)
    await h.core.pause({ kind: 'person', memberId: ASKER })
    await a.deliver(id)
    expect((await rowOf(db, id))!.report).toBe('resume')
    expect(h.turns().filter(t => t.source === 'action')).toEqual([])
    expect(h.dueTasks()).toContainEqual(expect.objectContaining({ id: deliverTaskId(id) }))
    await h.core.resume({ kind: 'person', memberId: ASKER })
    await a.deliver(id)
    await a.deliver(id)
    expect(h.turns().filter(t => t.chat_id === chat && t.source === 'action').map(t => t.client_key)).toEqual([resumeKey(id)])
  }))
})

describe('the asks sweep', () => {
  it('schedules a deliver task for each action changed since its last pass, once, and keeps its place', () => inAgent(async h => {
    const { turnId, chat } = await liveTurn(h)
    await db.prepare('DELETE FROM outbox_actions').run()
    const ids = [await action(h, turnId, chat, 1), await action(h, turnId, chat, 2)]
    const delivers = () => h.dueTasks().filter(t => t.id.startsWith('action-deliver:')).map(t => t.id).sort()
    await asks(h).sweep()
    expect(delivers()).toEqual(ids.map(deliverTaskId).sort())
    for (const id of ids) h.sched.cancel(deliverTaskId(id))
    // A row written in the same millisecond after a pass is read on the next one, whatever its id.
    const third = await action(h, turnId, chat, 3)
    await asks(h).sweep()
    expect(delivers()).toContain(deliverTaskId(third))
    // Once the clock has moved on, a pass reads only what changed within its overlap of the last one.
    h.clock.now += 10_000
    const fourth = await action(h, turnId, chat, 4)
    await asks(h).sweep()
    for (const id of [...ids, third, fourth]) h.sched.cancel(deliverTaskId(id))
    await asks(h).sweep()
    expect(delivers()).toEqual([deliverTaskId(fourth)])
    // Once the last row is older than the overlap, a pass schedules nothing again: the cursor is exactly past it.
    h.clock.now += 10_000
    await asks(h).sweep()
    h.sched.cancel(deliverTaskId(fourth))
    await asks(h).sweep()
    await asks(h).sweep()
    expect(delivers()).toEqual([])
  }))
})

describe('the D1 report store (failure 6)', () => {
  it('changes `report` only from the given values, and nothing else on the row', () => inAgent(async h => {
    const { turnId, chat } = await liveTurn(h)
    const id = await action(h, turnId, chat)
    const before = (await rowOf(db, id))!
    const s = d1Reports(db)
    expect(await s.set(id, 'later', ['tool'])).toBe(false)
    expect(await s.set(id, 'tool', [null])).toBe(true)
    expect(await s.set(id, 'tool', [null])).toBe(false)
    expect(await s.set(id, 'resume', [null, 'later'])).toBe(false)
    expect(await s.set(id, 'later', ['tool'])).toBe(true)
    expect(await s.set(id, 'resume', [null, 'later'])).toBe(true)
    expect(await rowOf(db, id)).toEqual({ ...before, report: 'resume' })
    expect(await s.read(id)).toEqual({ id, state: 'waiting', report: 'resume', turnId, chatId: chat, askedBy: ASKER, jobId: null })
  }))
})
