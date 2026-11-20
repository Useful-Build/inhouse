// The history projection to D1 (p3-design 4.8) and a chat delete's endings (route 27, 4.6), through the engine on a
// real BrandAgent SQLite and the test D1. Expected rows are literals written from the design (ids `<turnId>.u` and
// `<turnId>.<n>`, positions from the chat's `next_pos` at the turn's end), never read from the code. Ways it can fail,
// written down first:
//  1. a final turn's rows aren't fixed in the final-state step, or get new positions on a retry (a doubled or moved
//     message after a reload);
//  2. a failed D1 batch, or one whose reply was lost after it committed, leaves the history short or doubled, or the
//     retry doesn't survive a reset;
//  3. `getChat`'s runs drop an ended run before its turns are in D1 (nothing to replay them from);
//  4. a chat delete ends a turn outside `storeFinal`, starts a queued turn on the way (a reserve, a placement), or
//     touches another chat's turns.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { openStores } from '../../db/stores.ts'
import { person } from '../../db/test-support.ts'
import { MIN, SEC, T0, ev, inAgent, settle } from '../../testing/brand-agent/core-harness.ts'
import type { Harness } from '../../testing/brand-agent/core-harness.ts'
import type { TurnRow } from './core.ts'

const stores = openStores(env)
let owner: string
beforeAll(async () => {
  owner = await person(stores, { email: `proj-${Math.random()}@example.test`, subject: `proj-${Math.random()}`, role: 'member' })
})

let n = 0
/** A chat in D1 (route 23 made it), last active long before the turns. */
async function chat(): Promise<string> {
  const id = `c_proj_${++n}_${Math.random().toString(36).slice(2, 8)}`
  await env.DB.prepare('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, ?, ?, ?)').bind(id, owner, 'A chat', 1_000, 1_000).run()
  return id
}
const d1Rows = async (chatId: string) => (await env.DB.prepare(
  'SELECT id, run_id, turn_id, pos, role, author_id, text, part_json, extra_json, model, at_ms FROM chat_messages WHERE chat_id = ? ORDER BY pos',
).bind(chatId).all()).results
const lastAt = async (chatId: string) => env.DB.prepare('SELECT last_at_ms FROM chats WHERE id = ?').bind(chatId).first<number>('last_at_ms')

/** A D1 whose batch fails (`fail`), commits and then loses its reply (`lost`), or works (`ok`). */
function flakyDb(): { db: D1Database; mode: { now: 'ok' | 'fail' | 'lost' } } {
  const mode = { now: 'ok' as 'ok' | 'fail' | 'lost' }
  const db = {
    prepare: (q: string) => env.DB.prepare(q),
    batch: async (s: D1PreparedStatement[]) => {
      if (mode.now === 'fail') throw new Error('D1_ERROR: scripted failure')
      const r = await env.DB.batch(s)
      if (mode.now === 'lost') throw new Error('Network connection lost.')
      return r
    },
  } as unknown as D1Database
  return { db, mode }
}

const id = (r: unknown) => (r as { turnId: string; runId: string })
const send = async (h: Harness, chatId: string, key: string, o: { quote?: string } = {}) => id(await h.submit(chatId, key, { member: owner, ...o }))
/** A whole answer, `text` as its one part, at the clock's time. */
const answer = (h: Harness, turnId: string, text: string) => h.push(turnId, ev.started(), ev.text(text), ev.checkpoint(2, null, null), ev.success(),
  ev.released({ mainEntries: 2, lastUuid: null, lastUuidIndex: null }))
const user = (t: { turnId: string; runId: string }, pos: number, text: string, atMs: number, extra: string | null = null) =>
  ({ id: `${t.turnId}.u`, run_id: t.runId, turn_id: t.turnId, pos, role: 'user', author_id: owner, text, part_json: null, extra_json: extra, model: null, at_ms: atMs })
const part = (t: { turnId: string; runId: string }, n: number, pos: number, text: string, atMs: number) =>
  ({ id: `${t.turnId}.${n}`, run_id: t.runId, turn_id: t.turnId, pos, role: 'agent', author_id: null, text, part_json: JSON.stringify({ type: 'text', text }), extra_json: JSON.stringify({ trace: t.turnId }), model: 'sonnet', at_ms: atMs })

describe('the projection (failure 1)', () => {
  it('a finished turn: its rows fixed at the end, written to D1, the chat moved to the end time', async () => {
    const c = await chat()
    await inAgent(async h => {
      const t = await send(h, c, 'key-proj01'); await settle()
      h.clock.now = T0 + 5 * SEC
      answer(h, t.turnId, 'Hello there'); await settle()
      expect(await d1Rows(c)).toEqual([user(t, 0, 'question key-proj01', T0), part(t, 0, 1, 'Hello there', T0 + 5 * SEC)])
      expect(await lastAt(c)).toBe(T0 + 5 * SEC)
      expect(h.turn(t.turnId)).toMatchObject({ pos_from: 0, pos_to: 1, d1_flushed: 1 })
      expect(h.sql.exec('SELECT next_pos FROM chat_state WHERE chat_id = ?', c).one()).toEqual({ next_pos: 2 })
      expect(h.dueTasks().filter(d => d.id.startsWith('flush-turn:'))).toEqual([])
      expect(h.core.chatRuns([c])).toEqual([])
    })
  })

  it('positions follow the order turns end in; a cancelled question keeps its row; a quote rides in extra_json', async () => {
    const c = await chat()
    await inAgent(async h => {
      const a = await send(h, c, 'key-proj02'); await settle()
      const b = await send(h, c, 'key-proj03', { quote: 'an earlier line' })
      const x = await send(h, c, 'key-proj04')
      h.clock.now = T0 + 1 * SEC
      expect(h.core.stop(x.turnId, { kind: 'person', memberId: owner })).toEqual({ ok: true })
      h.clock.now = T0 + 2 * SEC
      answer(h, a.turnId, 'first'); await settle()
      h.clock.now = T0 + 3 * SEC
      answer(h, b.turnId, 'second'); await settle()
      expect(await d1Rows(c)).toEqual([
        user(x, 0, 'question key-proj04', T0),
        user(a, 1, 'question key-proj02', T0), part(a, 0, 2, 'first', T0 + 2 * SEC),
        user(b, 3, 'question key-proj03', T0, JSON.stringify({ quote: 'an earlier line' })), part(b, 0, 4, 'second', T0 + 3 * SEC),
      ])
      expect(await lastAt(c)).toBe(T0 + 3 * SEC)
    })
  })
})

describe('a failed flush replays the same rows (failures 2 and 3)', () => {
  it('the batch failed: getChat keeps the run; the retry, after a reset, writes the same ids and positions', async () => {
    const c = await chat()
    const { db, mode } = flakyDb()
    await inAgent(async h => {
      mode.now = 'fail'
      const a = await send(h, c, 'key-proj05'); await settle()
      h.clock.now = T0 + 5 * SEC
      answer(h, a.turnId, 'one'); await settle()
      expect(await d1Rows(c)).toEqual([])
      expect(h.turn(a.turnId)).toMatchObject({ pos_from: 0, pos_to: 1, d1_flushed: 0 })
      expect(h.dueTasks().filter(d => d.id.startsWith('flush-turn:'))).toEqual([{ id: `flush-turn:${a.turnId}`, due_at_ms: T0 + 35 * SEC }])
      // run.started, turn.queued, turn.started, part, turn.finished, run.finished.
      expect(h.core.chatRuns([c])).toEqual([{ runId: a.runId, chatId: c, lastSeq: 6, live: false }])
      // The next turn takes the next positions while the first is still unflushed.
      const b = await send(h, c, 'key-proj06'); await settle()
      h.clock.now = T0 + 6 * SEC
      answer(h, b.turnId, 'two'); await settle()
      expect(h.turn(b.turnId)).toMatchObject({ pos_from: 2, pos_to: 3, d1_flushed: 0 })
      const after = h.restart()
      mode.now = 'ok'
      await after.tick(30 * SEC)
      expect(await d1Rows(c)).toEqual([
        user(a, 0, 'question key-proj05', T0), part(a, 0, 1, 'one', T0 + 5 * SEC),
        user(b, 2, 'question key-proj06', T0 + 5 * SEC), part(b, 0, 3, 'two', T0 + 6 * SEC),
      ])
      expect(after.turn(a.turnId).d1_flushed).toBe(1)
      expect(after.turn(b.turnId).d1_flushed).toBe(1)
      expect(after.core.chatRuns([c])).toEqual([])
      expect(await lastAt(c)).toBe(T0 + 6 * SEC)
    }, { db })
  })

  it('the batch committed but its reply was lost: the retry changes nothing, and the turn is then flushed', async () => {
    const c = await chat()
    const { db, mode } = flakyDb()
    await inAgent(async h => {
      mode.now = 'lost'
      const a = await send(h, c, 'key-proj07'); await settle()
      h.clock.now = T0 + 5 * SEC
      answer(h, a.turnId, 'kept once'); await settle()
      const expected = [user(a, 0, 'question key-proj07', T0), part(a, 0, 1, 'kept once', T0 + 5 * SEC)]
      expect(await d1Rows(c)).toEqual(expected)
      expect(h.turn(a.turnId).d1_flushed).toBe(0)
      expect(h.core.chatRuns([c])).toEqual([{ runId: a.runId, chatId: c, lastSeq: 6, live: false }])
      mode.now = 'ok'
      await h.tick(30 * SEC)
      expect(await d1Rows(c)).toEqual(expected)
      expect(h.turn(a.turnId).d1_flushed).toBe(1)
      expect(h.core.chatRuns([c])).toEqual([])
    }, { db })
  })

  it('a live run is in getChat\'s runs, and only for its own chat', async () => {
    const c = await chat()
    const other = await chat()
    await inAgent(async h => {
      const a = await send(h, c, 'key-proj08'); await settle()
      h.push(a.turnId, ev.started())
      // run.started, turn.queued, turn.started.
      expect(h.core.chatRuns([c, other])).toEqual([{ runId: a.runId, chatId: c, lastSeq: 3, live: true }])
      expect(h.core.chatRuns([other])).toEqual([])
    })
  })
})

describe('a chat delete ends its turns through storeFinal (failure 4)', () => {
  it('cancels the queued turns at once without starting any, fences the live one; another chat runs on', async () => {
    const c = await chat()
    const other = await chat()
    await inAgent(async h => {
      const seen: string[] = []
      h.core.onFinal = (t: TurnRow) => { seen.push(`${t.turn_id} ${t.state} ${t.outcome ?? '-'} ${t.cancel_why ?? '-'}`) }
      const live = await send(h, c, 'key-proj09'); await settle()
      h.push(live.turnId, ev.started(), ev.text('partial'))
      const q1 = await send(h, c, 'key-proj10')
      const q2 = await send(h, c, 'key-proj11')
      const elsewhere = await send(h, other, 'key-proj12'); await settle()
      h.push(elsewhere.turnId, ev.started())
      const placedBefore = h.placed()
      const reservesBefore = h.usage.calls.filter(x => x.method === 'reserve').length
      h.core.endChats([c])
      await settle()
      expect(seen).toEqual([`${q1.turnId} cancelled - deleted`, `${q2.turnId} cancelled - deleted`])
      expect(h.placed()).toEqual(placedBefore)
      expect(h.usage.calls.filter(x => x.method === 'reserve').length).toBe(reservesBefore)
      expect(h.turn(live.turnId)).toMatchObject({ state: 'ending', fenced: 1, outcome: 'cancelled', cancel_why: 'deleted' })
      expect(h.pool.calls.filter(x => x.method === 'stop').map(x => x.args[1])).toEqual([live.turnId])
      expect(h.turn(elsewhere.turnId).state).toBe('live')
      h.push(live.turnId, ev.released({ mainEntries: 3, lastUuid: null, lastUuidIndex: null }))
      await settle()
      expect(seen.at(-1)).toBe(`${live.turnId} ended cancelled deleted`)
      // Each one projected: the queued questions, then the live turn with the part it wrote.
      expect((await d1Rows(c)).map(r => `${r.id} ${r.pos}`)).toEqual([`${q1.turnId}.u 0`, `${q2.turnId}.u 1`, `${live.turnId}.u 2`, `${live.turnId}.0 3`])
      // The run ended with its last turn.
      expect(h.core.chatRuns([c])).toEqual([])
      expect(h.turn(elsewhere.turnId).state).toBe('live')
    })
  })

  it('a chat whose queued turns wait with nothing live (a budget wait): every one cancelled, none claimed', async () => {
    const c = await chat()
    await inAgent(async h => {
      const seen: string[] = []
      h.core.onFinal = (t: TurnRow) => { seen.push(`${t.turn_id} ${t.state} ${t.cancel_why ?? '-'}`) }
      // `budget_busy` sends the first turn back to the queue (4.4 step 2): two queued turns, none in starting|live|ending.
      h.usage.reserveAnswer = { refused: 'budget_busy' }
      const a = await send(h, c, 'key-proj13'); await settle()
      const b = await send(h, c, 'key-proj14')
      expect(h.turn(a.turnId).state).toBe('queued')
      expect(h.turn(b.turnId).state).toBe('queued')
      h.usage.reserveAnswer = { reservedMicro: 250_000 }
      const reserves = h.usage.calls.filter(x => x.method === 'reserve').length
      h.core.endChats([c])
      await settle()
      expect(seen).toEqual([`${a.turnId} cancelled deleted`, `${b.turnId} cancelled deleted`])
      expect(h.usage.calls.filter(x => x.method === 'reserve').length).toBe(reserves)
      await h.tick(MIN)
      expect(h.usage.calls.filter(x => x.method === 'reserve').length).toBe(reserves)
    })
  })
})
