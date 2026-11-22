// The eval trace (p3-eval-observability rev 2, rec 5, option a-i): the eval build keeps each tool call's capped input
// (the audit entry `capInput` already capped) in `turn_trace`, keyed by its tool_use id, and route 33 shows it on the
// call's `tool` step to the run's owner only. Ways it can fail, written down first:
//  1. Inhouse's `{ all: true }` scope (support access under a grant) sees an input: BD7 gives the Inhouse team no `io`;
//  2. the owner's trace misses the input of a call that has one, or shows it on the wrong step;
//  3. a build that isn't the eval build (the product or test build, or this compile's default) keeps or shows any input;
//  4. a trace (a run, over all its turns) keeps more than 256 KB of inputs as stored (JSON-escaped, with their ids), or cuts
//     one without saying so, or cuts inside a character;
//  5. a second audit entry for the same call (another hook) doubles its input, or an entry without a tool_use id is kept;
//  6. the TTL task deletes anything but inputs older than 7 days, or stops running;
//  7. the off module (every other build) keeps, reads or schedules anything;
//  8. `GET /api/me` says `evalBrand` outside the eval build or without the deploy-time marker;
//  9. the eval build's task registry drops the TTL task (the 7-day promise breaks silently);
// 10. a call's input recorded before its step (the audit post winning the race) isn't shown on it;
// 11. deleting a person leaves their kept inputs behind;
// 12. (#245 review) the kept input is the runner's capInput wrapper instead of the tool's input, a runner-side cut isn't
//     marked cut, or a WebFetch the runner's hook denied isn't marked denied. Oracle: the golden file of what the real
//     runner hooks send (app/evals/fixtures/runner-audit.json, pinned by runner/test/guards/hook-audit.test.ts).
// Oracles: literal inputs and byte counts, and the scope rule written out here.
import { describe, expect, it, vi } from 'vitest'
import type { SendTurnResult } from '../../shared/contract/runs.ts'
import { MeSchema } from '../../shared/contract/me.ts'
import type { Refusal } from '../do/brand-agent/ports.ts'
import type { DueTask, TaskContext } from '../do/brand-agent/scheduler.ts'
import { meHandler } from '../auth/me-handler.ts'
import type { HandlerContext } from '../routes.ts'
import { DESIGN_CAN_ROWS, DESIGN_ROWS, fakeStores } from '../testing/auth-fixtures.ts'
import { MEMBER, OTHER, SEC, T0, ev, fullAnswer, inAgent, settle } from '../testing/brand-agent/core-harness.ts'
import { buildTaskHandlers, taskHandlers } from '../do/brand-agent/tasks/index.ts'
import { registrySeeds } from '../do/brand-agent/scheduler.ts'
import type { AuditEntry } from '../../shared/protocol/index.ts'
import * as on from './on.ts'
import * as off from './off.ts'

const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}
/** The runner's audit entries for three real calls (runner/test/guards/hook-audit.test.ts keeps this file equal to them). */
const GOLDEN = JSON.parse(Object.values(import.meta.glob('../../evals/fixtures/runner-audit.json', { query: '?raw', import: 'default', eager: true }))[0] as string) as AuditEntry[]
/** An entry as the runner sends it: the input in capInput's `{ cut: false, value }` (pinned to the golden file below). */
const wrapped = (value: unknown) => ({ cut: false, value })
const entry = (toolUseId: string | undefined, input: unknown) =>
  ({ hook: 'PreToolUse', toolName: 'WebFetch', ...(toolUseId === undefined ? {} : { toolUseId }), decision: 'allow', input: wrapped(input) })
/** One assistant message with one tool_use block of this id, as the SDK sends it. */
const toolUse = (id: string, name: string) =>
  ({ type: 'sdk', truncated: false, message: { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } } }) as const
const ioRows = (sql: SqlStorage, turnId: string) =>
  sql.exec<{ json: string }>("SELECT json FROM turn_trace WHERE turn_id = ? AND json_extract(json, '$.io') IS NOT NULL ORDER BY n", turnId).toArray()
    .map(r => JSON.parse(r.json) as Record<string, string>)

describe('the eval trace on route 33', () => {
  it("shows a call's input on its tool step to the owner only, never to Inhouse's all scope (failures 1, 2)", () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-evt01'))
    await settle()
    h.clock.now = T0 + 1 * SEC
    // The harness's tool_use block has id `tu_1`.
    h.push(a.turnId, ev.started(), ev.tool('WebFetch'))
    await h.core.writeToolCall(a.turnId, 0, entry('tu_1', { url: 'https://shop.example.test/a' }))
    h.clock.now = T0 + 3 * SEC
    h.push(a.turnId, ...fullAnswer('done', 2))
    await settle()
    const toolStep = (t: ReturnType<typeof h.core.readTrace>) => t?.steps.find(s => s.kind === 'tool')
    expect(toolStep(h.core.readTrace(a.turnId, { owner: MEMBER }))).toEqual({
      label: 'Reading a web page', kind: 'tool', startMs: 1000, endMs: 1000, depth: 1, detail: 'WebFetch',
      io: { input: '{"url":"https://shop.example.test/a"}' },
    })
    expect(toolStep(h.core.readTrace(a.runId, { owner: MEMBER }))?.io).toEqual({ input: '{"url":"https://shop.example.test/a"}' })
    for (const id of [a.turnId, a.runId]) {
      const all = h.core.readTrace(id, { all: true })
      expect(all?.steps.length, id).toBeGreaterThan(1)
      expect(JSON.stringify(all), id).not.toContain('shop.example.test')
      expect(all?.steps.some(s => 'io' in s), id).toBe(false)
    }
    expect(h.core.readTrace(a.turnId, { owner: OTHER })).toBeNull()
  }, { evalTrace: true }))

  it("replays the real runner's entries: the tool's input unwrapped, the hook's denial and a runner-side cut on the owner's steps, nothing for Inhouse (failures 1, 2, 12)", () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-evt05'))
    await settle()
    h.push(a.turnId, ev.started(), toolUse('toolu_listed', 'WebFetch'), toolUse('toolu_unlisted', 'WebFetch'), toolUse('toolu_bash', 'Bash'))
    // As the root does with each entry: an `audit` run event (the trace) and the audit route's post (writeToolCall).
    let n = 0
    for (const e of GOLDEN) {
      h.push(a.turnId, { type: 'audit', entry: e })
      await h.core.writeToolCall(a.turnId, n++, e)
    }
    h.push(a.turnId, ...fullAnswer('done', 2))
    await settle()
    const steps = h.core.readTrace(a.turnId, { owner: MEMBER })!.steps.filter(s => s.kind === 'tool')
    const value = (i: number) => JSON.stringify((GOLDEN[i]!.input as { value: unknown }).value)
    expect(steps.map(s => s.io)).toEqual([
      { input: value(0) },
      { input: value(1), denied: true },
      // The runner cut the Bash input: what's kept is the start of its JSON text, marked cut.
      { input: (GOLDEN[3]!.input as { head: string }).head, cut: true },
    ])
    expect(JSON.parse(steps[0]!.io!.input)).toEqual({ url: 'https://docs.example.com/guide', prompt: 'Summarise it.' })
    expect(h.core.readTrace(a.turnId, { all: true })?.steps.some(s => 'io' in s)).toBe(false)
  }, { evalTrace: true }))

  it('the tests\' own entries wrap the input as the real runner does (failure 12)', () => {
    expect(GOLDEN[0]!.input).toEqual(wrapped({ url: 'https://docs.example.com/guide', prompt: 'Summarise it.' }))
  })

  it('an input in no known wrapper is kept as its JSON, marked cut: never read as the tool\'s input (failure 12)', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-evt09'))
    await settle()
    await h.core.writeToolCall(a.turnId, 0, { hook: 'PreToolUse', toolName: 'WebFetch', toolUseId: 'tu_raw', decision: 'allow', input: { url: 'https://raw.example.test/' } })
    expect(ioRows(h.sql, a.turnId)).toEqual([{ io: 'tu_raw', input: '{"url":"https://raw.example.test/"}', bytes: '65', cut: '1' }])
  }, { evalTrace: true }))

  it('keeps and shows nothing outside the eval build (failure 3)', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-evt02'))
    await settle()
    h.push(a.turnId, ev.started(), ev.tool('WebFetch'))
    await h.core.writeToolCall(a.turnId, 0, entry('tu_1', { url: 'https://shop.example.test/b' }))
    h.push(a.turnId, ...fullAnswer('done', 2))
    await settle()
    expect(ioRows(h.sql, a.turnId)).toEqual([])
    expect(JSON.stringify(h.core.readTrace(a.turnId, { owner: MEMBER }))).not.toContain('shop.example.test')
  }))

  it('keeps one input per call and none without a tool_use id (failure 5)', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-evt03'))
    await settle()
    await h.core.writeToolCall(a.turnId, 0, entry('tu_1', { url: 'https://first.example.test/' }))
    await h.core.writeToolCall(a.turnId, 1, entry('tu_1', { url: 'https://second.example.test/' }))
    await h.core.writeToolCall(a.turnId, 2, entry(undefined, { url: 'https://none.example.test/' }))
    // `bytes` is the stored size: the record's JSON with its id and the input escaped inside it.
    expect(ioRows(h.sql, a.turnId)).toEqual([{ io: 'tu_1', input: '{"url":"https://first.example.test/"}', bytes: '65' }])
  }, { evalTrace: true }))

  it('caps a run\'s trace at 256 KB of inputs as stored, over all its turns, marking the cut (failure 4)', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-evt04'))
    await settle()
    // A second turn of the same chat, queued behind the first: the same run, so the same trace.
    const b = ok(await h.submit('c1', 'key-evt14'))
    await settle()
    expect(b.runId).toBe(a.runId)
    // A 16,000-character string is 16,002 bytes of JSON; stored escaped inside the record with its id, 16,028 bytes for
    // tu_0 to tu_9 and 16,029 for tu_10 to tu_15: 256,454 in all, leaving 5,690 of the 262,144.
    const big = 'x'.repeat(16_000)
    for (let i = 0; i < 16; i++) await h.core.writeToolCall(a.turnId, i, entry(`tu_${i}`, big))
    const first = ioRows(h.sql, a.turnId)
    expect(first.map(r => r.bytes)).toEqual([...Array(10).fill('16028'), ...Array(6).fill('16029')])
    expect(first.every(r => r.cut === undefined)).toBe(true)
    // The second turn's first call crosses the run's cap: cut at 5,664 characters (stored size 5,690, exactly the room).
    await h.core.writeToolCall(b.turnId, 0, entry('tu_16', big))
    const [cut] = ioRows(h.sql, b.turnId)
    expect(cut).toEqual({ io: 'tu_16', input: `"${'x'.repeat(5_663)}`, bytes: '5690', cut: '1' })
    expect([...first, cut].reduce((n, r) => n + Number(r.bytes), 0)).toBe(on.IO_TRACE_MAX_BYTES)
    expect(on.ioFrom(cut)).toEqual(['tu_16', { input: `"${'x'.repeat(5_663)}`, cut: true }])
    // A later call gets an empty, cut input (its record's own 25 bytes): the reader still sees that one was made.
    await h.core.writeToolCall(b.turnId, 1, entry('tu_17', { url: 'https://late.example.test/' }))
    expect(ioRows(h.sql, b.turnId)[1]).toEqual({ io: 'tu_17', input: '', bytes: '25', cut: '1' })
  }, { evalTrace: true }))

  it('cuts at whole characters, keeping a real U+FFFD and never splitting an escape (failure 4)', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-evt06'))
    await settle()
    const big = 'x'.repeat(16_000)
    for (let i = 0; i < 16; i++) await h.core.writeToolCall(a.turnId, i, entry(`tu_${i}`, big))
    // 5,690 bytes of room: a string of 4-byte characters, with a genuine U+FFFD and a quote, is cut at a whole character.
    const odd = `\uFFFD"${'😀'.repeat(4_000)}`
    await h.core.writeToolCall(a.turnId, 16, entry('tu_16', odd))
    const cut = ioRows(h.sql, a.turnId)[16]
    expect(cut.cut).toBe('1')
    expect(cut.input.startsWith('"\uFFFD\\"😀')).toBe(true)
    expect(cut.input.endsWith('😀')).toBe(true)
    expect(Number(cut.bytes)).toBeLessThanOrEqual(5_690)
    expect(Number(cut.bytes)).toBeGreaterThan(5_690 - 4)
  }, { evalTrace: true }))

  it('shows an input recorded before its step (failure 10)', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-evt07'))
    await settle()
    h.push(a.turnId, ev.started())
    await h.core.writeToolCall(a.turnId, 0, entry('tu_1', { url: 'https://early.example.test/' }))
    h.push(a.turnId, ev.tool('WebFetch'), ...fullAnswer('done', 2))
    await settle()
    expect(h.core.readTrace(a.turnId, { owner: MEMBER })?.steps.find(s => s.kind === 'tool')?.io).toEqual({ input: '{"url":"https://early.example.test/"}' })
  }, { evalTrace: true }))

  it('deleting a person removes their kept inputs (failure 11)', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-evt08'))
    await settle()
    h.push(a.turnId, ev.started())
    await h.core.writeToolCall(a.turnId, 0, entry('tu_1', { url: 'https://person.example.test/' }))
    h.push(a.turnId, ...fullAnswer('done', 2))
    await settle()
    expect(ioRows(h.sql, a.turnId)).toHaveLength(1)
    // The turn's rows are in D1 (PR 3's flush), so the delete isn't busy.
    h.sql.exec('UPDATE turns SET d1_flushed = 1 WHERE turn_id = ?', a.turnId)
    expect(h.core.personData(MEMBER, 'delete')).not.toEqual({ busy: true })
    expect(ioRows(h.sql, a.turnId)).toEqual([])
  }, { evalTrace: true }))
})

describe('the eval build\'s task registry (failure 9)', () => {
  it('holds the TTL task, seeded, in the eval build only', () => {
    const evalBuild = buildTaskHandlers(true)
    expect(Object.keys(evalBuild)).toContain(on.IO_TTL_TASK)
    expect(evalBuild[on.IO_TTL_TASK].seed).toEqual({ id: on.IO_TTL_TASK })
    expect(Object.keys(buildTaskHandlers(false))).not.toContain(on.IO_TTL_TASK)
    // This compile (as the product build) registers what the eval-off registry does.
    expect(Object.keys(taskHandlers)).toEqual(Object.keys(buildTaskHandlers(false)))
    expect(registrySeeds(evalBuild)).toContainEqual({ id: on.IO_TTL_TASK, kind: on.IO_TTL_TASK })
  })
})

describe('the TTL task (failure 6)', () => {
  it('deletes inputs older than 7 days only, and schedules its next pass', () => inAgent(async h => {
    const now = T0 + 30 * 86_400_000
    const old = now - on.IO_TTL_MS - 1
    const fresh = now - on.IO_TTL_MS + 1
    const put = (n: number, at: number, rec: Record<string, string>) =>
      h.sql.exec('INSERT INTO turn_trace (turn_id, n, at_ms, json) VALUES (?, ?, ?, ?)', 't_ttl', n, at, JSON.stringify(rec))
    put(0, old, { io: 'tu_a', input: '"old"', bytes: '5' })
    put(1, old, { step: 'Reading a web page', tool: 'WebFetch', id: 'tu_a' })
    put(2, fresh, { io: 'tu_b', input: '"new"', bytes: '5' })
    const schedule = vi.fn()
    const task: DueTask = { id: on.IO_TTL_TASK, kind: on.IO_TTL_TASK, gen: 1, dueAtMs: now, payload: null, attempts: 0 }
    const handler = on.EVAL_TASKS[on.IO_TTL_TASK]
    expect(handler.seed).toEqual({ id: on.IO_TTL_TASK })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await handler(task, { nowMs: now, sql: h.sql, scheduler: { schedule } } as unknown as TaskContext)).toEqual({ done: true })
    // The real number of inputs deleted (not the storage's row-write count, which counts index writes too).
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'eval_io_ttl', deleted: 1 }))
    log.mockRestore()
    const left = h.sql.exec<{ n: number }>("SELECT n FROM turn_trace WHERE turn_id = 't_ttl' ORDER BY n").toArray().map(r => r.n)
    expect(left).toEqual([1, 2])
    expect(schedule).toHaveBeenCalledWith({ id: on.IO_TTL_TASK, kind: on.IO_TTL_TASK, dueAtMs: now + 6 * 3_600_000 })
  }))
})

describe('the off module (failure 7)', () => {
  it('keeps, reads and schedules nothing', () => {
    expect(off.ioRecord({} as SqlStorage, 't_1', entry('tu_1', { url: 'x' }))).toBeNull()
    expect(off.ioFrom({ io: 'tu_1', input: '"x"', bytes: '3' })).toBeNull()
    expect(off.EVAL_TASKS).toEqual({})
    expect(off.EVAL_TRACE_CANARY).toBe('')
  })
})

describe('GET /api/me: evalBrand (failure 8)', () => {
  const principal = { kind: 'person', memberId: 'm_member', role: 'member', subject: 'member', requestId: 'r1', expMs: Date.now() + 60_000 }
  const call = async (compiledEval: boolean, env: Record<string, string>) => {
    const s = fakeStores({ people: { member: { role: 'member' } } })
    const res = await meHandler({ rows: DESIGN_ROWS, canRows: DESIGN_CAN_ROWS, compiledEval })(
      { principal, requestId: 'r1', nowMs: Date.now(), stores: s.stores, env } as unknown as HandlerContext)
    expect(res.status).toBe(200)
    return MeSchema.parse(await res.json())
  }
  it('is true only in the eval build with INHOUSE_EVAL_BRAND = "1"', async () => {
    expect((await call(true, { INHOUSE_EVAL_BRAND: '1' })).evalBrand).toBe(true)
    for (const [compiled, env] of [[true, {}], [true, { INHOUSE_EVAL_BRAND: 'true' }], [false, { INHOUSE_EVAL_BRAND: '1' }]] as const) {
      expect('evalBrand' in (await call(compiled, env)), JSON.stringify([compiled, env])).toBe(false)
    }
  })
  it("this compile (the product build's default) never says it", async () => {
    const s = fakeStores({ people: { member: { role: 'member' } } })
    const res = await meHandler({ rows: DESIGN_ROWS, canRows: DESIGN_CAN_ROWS })(
      { principal, requestId: 'r1', nowMs: Date.now(), stores: s.stores, env: { INHOUSE_EVAL_BRAND: '1' } } as unknown as HandlerContext)
    expect('evalBrand' in MeSchema.parse(await res.json())).toBe(false)
  })
})
