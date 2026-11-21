// The eval trace (p3-eval-observability rev 2, rec 5, option a-i): the eval build keeps each tool call's capped input
// (the audit entry `capInput` already capped) in `turn_trace`, keyed by its tool_use id, and route 33 shows it on the
// call's `tool` step to the run's owner only. Ways it can fail, written down first:
//  1. Inhouse's `{ all: true }` scope (support access under a grant) sees an input: BD7 gives the Inhouse team no `io`;
//  2. the owner's trace misses the input of a call that has one, or shows it on the wrong step;
//  3. a build that isn't the eval build (the product or test build, or this compile's default) keeps or shows any input;
//  4. a trace keeps more than 256 KB of inputs, or cuts one without saying so;
//  5. a second audit entry for the same call (another hook) doubles its input, or an entry without a tool_use id is kept;
//  6. the TTL task deletes anything but inputs older than 7 days, or stops running;
//  7. the off module (every other build) keeps, reads or schedules anything;
//  8. `GET /api/me` says `evalBrand` outside the eval build or without the deploy-time marker.
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
import * as on from './on.ts'
import * as off from './off.ts'

const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}
const entry = (toolUseId: string | undefined, input: unknown) =>
  ({ hook: 'PreToolUse', toolName: 'WebFetch', ...(toolUseId === undefined ? {} : { toolUseId }), decision: 'allow', input })
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

  it("marks the owner's tool step denied when a hook denied that call, for Inhouse never (failures 1, 2)", () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-evt05'))
    await settle()
    h.push(a.turnId, ev.started(), ev.tool('WebFetch'))
    const denied = { hook: 'PreToolUse', toolName: 'WebFetch', toolUseId: 'tu_1', decision: 'deny', input: { url: 'https://collect.evil.test/' } }
    h.push(a.turnId, { type: 'audit', entry: denied })
    await h.core.writeToolCall(a.turnId, 0, denied)
    h.push(a.turnId, ...fullAnswer('done', 2))
    await settle()
    const step = h.core.readTrace(a.turnId, { owner: MEMBER })?.steps.find(s => s.kind === 'tool')
    expect(step?.io).toEqual({ input: '{"url":"https://collect.evil.test/"}', denied: true })
    expect(h.core.readTrace(a.turnId, { all: true })?.steps.some(s => 'io' in s)).toBe(false)
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
    expect(ioRows(h.sql, a.turnId)).toEqual([{ io: 'tu_1', input: '{"url":"https://first.example.test/"}', bytes: '37' }])
  }, { evalTrace: true }))

  it('caps a trace at 256 KB of inputs, marking the cut (failure 4)', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-evt04'))
    await settle()
    // 17 inputs of 16,002 bytes each (a 16,000-byte string in JSON quotes; the audit route caps one at 16 KiB).
    const big = 'x'.repeat(16_000)
    for (let i = 0; i < 17; i++) await h.core.writeToolCall(a.turnId, i, entry(`tu_${i}`, big))
    const rows = ioRows(h.sql, a.turnId)
    expect(rows).toHaveLength(17)
    expect(rows.slice(0, 16).every(r => r.bytes === '16002' && r.cut === undefined)).toBe(true)
    // 16 x 16,002 = 256,032 bytes fit under 262,144, leaving 6,112 for the 17th, which is cut there.
    expect(rows[16]).toEqual({ io: 'tu_16', input: `"${'x'.repeat(6_111)}`, bytes: '6112', cut: '1' })
    expect(rows.reduce((n, r) => n + Number(r.bytes), 0)).toBe(on.IO_TRACE_MAX_BYTES)
    // A later call gets an empty, cut input: the reader still sees that one was made.
    await h.core.writeToolCall(a.turnId, 17, entry('tu_17', { url: 'https://late.example.test/' }))
    expect(ioRows(h.sql, a.turnId)[17]).toEqual({ io: 'tu_17', input: '', bytes: '0', cut: '1' })
    expect(on.ioFrom(rows[16])).toEqual(['tu_16', { input: `"${'x'.repeat(6_111)}`, cut: true }])
  }, { evalTrace: true }))
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
    expect(await handler(task, { nowMs: now, sql: h.sql, scheduler: { schedule } } as unknown as TaskContext)).toEqual({ done: true })
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
