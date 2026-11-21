// PR 5, the routine seams for P4 (p3-w1.md "Added by A1: PR 5", A2's two notes): the in-object submit (A), the end
// task on every final path (B), structured output (C), the payload hash and the system member's admission (G). Every
// expected value is a literal written here (payloads, hashes from `shasum`, refusals), never read from core.ts. Ways it
// can fail, written down first:
//  1. a path that makes a turn final (finished, failed incl. structured_output, stopped, interrupted, cancelled while
//     queued or starting by pause, stop or removal, cap_reached, the watchdog's and the requeue limit's
//     session_crashed, the inactivity timeout) stores the turn without its end task, in a later step than the final
//     write, twice, or with the wrong outcome, failure or structured output;
//  2. the format never reaches `RunStart`, the structured output isn't kept, or a result that raced a stop is lost;
//  3. the StructuredOutput tool's 200 KiB input or the result message's `structured_output` reaches the stored events,
//     the trace or route 33;
//  4. the hash misses a field the internal caller sent (effort, outputFormat, onEnd: a changed send dedupes) or covers a
//     server-resolved one (a settings change turns a retry into key_reused);
//  5. a person (or Inhouse) submits as `m_system`, `m_system` reaches a person's chat or a person reaches its chat, or
//     the internal path admits an attachment named twice, a bad format or an unregistered end kind;
//  6. route 29's RPC lets a caller set an end task or a format.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { SendTurnResult } from '../../../shared/contract/runs.ts'
import type { RunEventBody } from '../../../shared/protocol/index.ts'
import { MEMBER, MIN, SEC, deferred, ev, inAgent, settle } from '../../testing/brand-agent/core-harness.ts'
import type { Harness } from '../../testing/brand-agent/core-harness.ts'
import type { InternalSubmit, Refusal } from './ports.ts'
import type { TaskHandler } from './scheduler.ts'
import { internalSubmit } from './task-ops.ts'
import { createAgentTables } from './schema.ts'

const SYSTEM = { kind: 'service' as const, memberId: 'm_system' }
const testEnd: TaskHandler = async () => ({ done: true })
const HANDLERS = { 'test-end': testEnd }
const inSeams = (fn: (h: Harness) => Promise<void>) => inAgent(fn, { handlers: HANDLERS })

const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}

/** A routine-like submit: the system member, the test's end kind, optional format. */
function submit(h: Harness, chatId: string, key: string, o: Partial<InternalSubmit> & { text?: string } = {}) {
  const { text = `question ${key}`, ...rest } = o
  const t: InternalSubmit = {
    chatId, by: SYSTEM, model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium', sideModel: 'claude-haiku-5-5',
    maxTurns: 25, webFetchDomains: null, onEnd: { kind: 'test-end', id: `test-end:${key}` },
    input: { clientTurnKey: key, text, priority: 'next', model: 'sonnet', attachments: [] },
    ...rest,
  }
  return internalSubmit(h.core, h.sql, h.registry, t)
}

interface Seen { kind: string; id: string; due_at_ms: number; payload: unknown }
/**
 * What the end task looked like inside the final step itself (`onFinal` runs in `storeFinal`'s synchronous step, after
 * the final write): proves the task is written in that step, before any await, so no crash can fall between them.
 */
function captureEnds(h: Harness): Map<string, (Seen | null)[]> {
  const seen = new Map<string, (Seen | null)[]>()
  h.core.onFinal = t => {
    const id = `test-end:${t.client_key}`
    const row = h.sql.exec<{ kind: string; id: string; due_at_ms: number; payload_json: string }>(
      'SELECT kind, id, due_at_ms, payload_json FROM due_tasks WHERE id = ?', id).toArray()[0]
    const list = seen.get(t.turn_id) ?? []
    list.push(row ? { kind: row.kind, id: row.id, due_at_ms: row.due_at_ms, payload: JSON.parse(row.payload_json) } : null)
    seen.set(t.turn_id, list)
  }
  return seen
}

const released = (n = 2) => ev.released({ mainEntries: n, lastUuid: null, lastUuidIndex: null })
const finishedWith = (structuredOutput: unknown): RunEventBody =>
  ({ type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 0.01, usage: {}, structuredOutput })

describe('B: the end task on every final path, in the final step (failure 1)', () => {
  const end = (key: string, a: SendTurnResult, atMs: number, outcome: string, failure: string | null, structuredOutput: unknown = null, chatId = chatOf(key)): Seen => ({
    kind: 'test-end', id: `test-end:${key}`, due_at_ms: atMs,
    payload: { turnId: a.turnId, runId: a.runId, chatId, outcome, failure, structuredOutput },
  })
  const chatOf = (key: string) => `rc-${key}`

  it('finished (done, with its structured output), failed max_turns, failed structured_output', () => inSeams(async h => {
    const seen = captureEnds(h)
    const done = ok(await submit(h, chatOf('k-done-01'), 'k-done-01')); await settle()
    h.push(done.turnId, ev.started(), ev.text('a'), ev.checkpoint(2), finishedWith({ statements: ['ok'] }), released())
    const maxed = ok(await submit(h, chatOf('k-maxt-01'), 'k-maxt-01')); await settle()
    h.push(maxed.turnId, ev.started(), ev.text('a'), ev.checkpoint(2), ev.finished('error_max_turns'), released())
    const so = ok(await submit(h, chatOf('k-sout-01'), 'k-sout-01')); await settle()
    h.push(so.turnId, ev.started(), ev.text('a'), ev.checkpoint(2), ev.failed('structured_output'), released())
    const at = h.clock.now
    expect(seen.get(done.turnId)).toEqual([end('k-done-01', done, at, 'done', null, { statements: ['ok'] })])
    expect(seen.get(maxed.turnId)).toEqual([end('k-maxt-01', maxed, at, 'failed', 'max_turns')])
    expect(seen.get(so.turnId)).toEqual([end('k-sout-01', so, at, 'failed', 'structured_output')])
  }))

  it('stopped and interrupted while live; a result that raced the stop keeps its structured output', () => inSeams(async h => {
    const seen = captureEnds(h)
    const stopped = ok(await submit(h, chatOf('k-stop-01'), 'k-stop-01')); await settle()
    h.push(stopped.turnId, ev.started(), ev.text('a'))
    expect(h.core.stop(stopped.turnId, SYSTEM)).toEqual({ ok: true })
    h.push(stopped.turnId, ev.failed('stopped'), released())
    const raced = ok(await submit(h, chatOf('k-race-01'), 'k-race-01')); await settle()
    h.push(raced.turnId, ev.started(), ev.text('a'))
    h.core.stop(raced.turnId, SYSTEM)
    h.push(raced.turnId, finishedWith({ n: 2 }), released())
    const interrupted = ok(await submit(h, chatOf('k-intr-01'), 'k-intr-01')); await settle()
    h.push(interrupted.turnId, ev.started(), ev.text('a'))
    h.core.interrupt(interrupted.turnId, SYSTEM)
    h.push(interrupted.turnId, ev.finished('error_during_execution'), released())
    const at = h.clock.now
    expect(seen.get(stopped.turnId)).toEqual([end('k-stop-01', stopped, at, 'stopped', null)])
    expect(seen.get(raced.turnId)).toEqual([end('k-race-01', raced, at, 'stopped', null, { n: 2 })])
    expect(seen.get(interrupted.turnId)).toEqual([end('k-intr-01', interrupted, at, 'interrupted', null)])
  }))

  it('cancelled while queued (stop, pause), while starting (pause during reserve), and the live turn pause fenced', () => inSeams(async h => {
    const seen = captureEnds(h)
    const chat = chatOf('k-q-live')
    const live = ok(await submit(h, chat, 'k-q-live')); await settle()
    h.push(live.turnId, ev.started(), ev.text('a'))
    const queuedStop = ok(await submit(h, chat, 'k-q-stop', { text: 'second' }))
    const queuedPause = ok(await submit(h, chat, 'k-q-paus', { text: 'third' }))
    expect([queuedStop.position, queuedPause.position]).toEqual(['queued', 'queued'])
    h.core.stop(queuedStop.turnId, SYSTEM)
    const atStop = h.clock.now
    // A turn starting in another chat, held at its reserve when the pause lands.
    const gate = deferred()
    h.core.beforeStep = async step => { if (step === 'reserve') await gate.promise }
    const starting = ok(await submit(h, chatOf('k-start-1'), 'k-start-1')); await settle()
    h.clock.now += SEC
    h.core.pause({ kind: 'person', memberId: 'm_admin' })
    const atPause = h.clock.now
    gate.resolve(); await settle()
    h.clock.now += SEC
    h.push(live.turnId, released())
    const atRelease = h.clock.now
    expect(seen.get(queuedStop.turnId)).toEqual([end('k-q-stop', queuedStop, atStop, 'stopped', null, null, chat)])
    expect(seen.get(queuedPause.turnId)).toEqual([end('k-q-paus', queuedPause, atPause, 'cancelled', 'paused', null, chat)])
    expect(seen.get(starting.turnId)).toEqual([end('k-start-1', starting, atPause, 'cancelled', 'paused')])
    expect(seen.get(live.turnId)).toEqual([end('k-q-live', live, atRelease, 'cancelled', 'paused', null, chat)])
  }))

  it('cancelled by removal (queued and live) and by cap_reached', () => inSeams(async h => {
    const seen = captureEnds(h)
    const person = { kind: 'person' as const, memberId: MEMBER }
    const live = ok(await submit(h, chatOf('k-rm-live'), 'k-rm-live', { by: person })); await settle()
    const queued = ok(await submit(h, chatOf('k-rm-live'), 'k-rm-queu', { by: person, text: 'second' }))
    h.core.onMemberRemoved(MEMBER)
    const atRemoval = h.clock.now
    h.clock.now += SEC
    h.push(live.turnId, ev.released(null, false))
    const atRelease = h.clock.now
    h.usage.reserveAnswer = { refused: 'cap_reached' }
    const capped = ok(await submit(h, chatOf('k-cap-001'), 'k-cap-001')); await settle()
    const chat = chatOf('k-rm-live')
    expect(seen.get(queued.turnId)).toEqual([end('k-rm-queu', queued, atRemoval, 'cancelled', 'removed', null, chat)])
    expect(seen.get(live.turnId)).toEqual([end('k-rm-live', live, atRelease, 'cancelled', 'removed')])
    expect(seen.get(capped.turnId)).toEqual([end('k-cap-001', capped, atRelease, 'cancelled', 'cap_reached')])
  }))

  it('the watchdog: session_crashed (status unknown twice) and the inactivity timeout', () => inSeams(async h => {
    const seen = captureEnds(h)
    const crashed = ok(await submit(h, chatOf('k-crash-1'), 'k-crash-1')); await settle()
    h.pool.statusAnswer = { state: 'unknown', containerGone: false }
    for (let i = 0; i < 10 && h.turn(crashed.turnId).state !== 'ended'; i++) await h.tick(MIN)
    expect(seen.get(crashed.turnId)).toEqual([end('k-crash-1', crashed, h.turn(crashed.turnId).ended_at_ms!, 'failed', 'session_crashed')])
    const slow = ok(await submit(h, chatOf('k-slow-01'), 'k-slow-01')); await settle()
    h.push(slow.turnId, ev.started())
    for (let i = 0; i < 13; i++) { await h.tick(MIN); h.push(slow.turnId, ev.heartbeat()) }
    h.push(slow.turnId, ev.released(null, false))
    expect(seen.get(slow.turnId)).toEqual([end('k-slow-01', slow, h.clock.now, 'failed', 'timeout')])
  }))

  it('the requeue limit: a placement that never answers fails session_crashed after 2 requeues', () => inSeams(async h => {
    const seen = captureEnds(h)
    h.pool.placeAnswer = () => new Promise(() => {})
    const lost = ok(await submit(h, chatOf('k-requ-01'), 'k-requ-01')); await settle()
    for (let i = 0; i < 60 && h.turn(lost.turnId).state !== 'ended'; i++) await h.tick(30 * SEC)
    expect(h.turn(lost.turnId).requeues).toBe(2)
    expect(seen.get(lost.turnId)).toEqual([end('k-requ-01', lost, h.turn(lost.turnId).ended_at_ms!, 'failed', 'session_crashed')])
  }))

  it('the scheduler delivers the payload to the end kind as stored; a turn without onEnd schedules nothing', async () => {
    const delivered: unknown[] = []
    const record: TaskHandler = async task => { delivered.push({ id: task.id, payload: task.payload }); return { done: true } }
    await inAgent(async h => {
      const a = ok(await submit(h, 'rc-deliver', 'k-deliv-1')); await settle()
      h.push(a.turnId, ev.started(), ev.text('a'), ev.checkpoint(2), finishedWith([1, 2]), released())
      const plain = ok(await h.submit('c-plain', 'k-plain-01')); await settle()
      h.push(plain.turnId, ev.started(), ev.text('a'), ev.checkpoint(2), ev.success(), released())
      await h.tick(SEC)
      expect(delivered).toEqual([{ id: 'test-end:k-deliv-1', payload: { turnId: a.turnId, runId: a.runId, chatId: 'rc-deliver', outcome: 'done', failure: null, structuredOutput: [1, 2] } }])
      expect(h.sql.exec("SELECT id FROM due_tasks WHERE id LIKE 'test-end:%'").toArray()).toEqual([])
    }, { handlers: { 'test-end': record } })
  })
})

describe('B: chat delete (route 27, #163\'s endChats) ends every turn through storeFinal with one end task', () => {
  it('queued, starting and live turns of deleted chats: cancelled deleted, exactly one end task each', () => inSeams(async h => {
    const seen = captureEnds(h)
    const live = ok(await submit(h, 'rc-del-a', 'k-del-live')); await settle()
    h.push(live.turnId, ev.started(), ev.text('a'))
    const queued = ok(await submit(h, 'rc-del-a', 'k-del-queu', { text: 'second' }))
    const gate = deferred()
    h.core.beforeStep = async step => { if (step === 'reserve') await gate.promise }
    const starting = ok(await submit(h, 'rc-del-b', 'k-del-strt')); await settle()
    expect([h.turn(live.turnId).state, h.turn(queued.turnId).state, h.turn(starting.turnId).state]).toEqual(['live', 'queued', 'starting'])
    h.clock.now += SEC
    h.core.endChats([{ id: 'rc-del-a', rev: 2 }, { id: 'rc-del-b', rev: 2 }])
    const atDelete = h.clock.now
    gate.resolve(); await settle()
    h.clock.now += SEC
    h.push(live.turnId, ev.released(null, false))
    const atRelease = h.clock.now
    const payload = (a: SendTurnResult, chatId: string) => ({ turnId: a.turnId, runId: a.runId, chatId, outcome: 'cancelled', failure: 'deleted', structuredOutput: null })
    expect(seen.get(queued.turnId)).toEqual([{ kind: 'test-end', id: 'test-end:k-del-queu', due_at_ms: atDelete, payload: payload(queued, 'rc-del-a') }])
    expect(seen.get(starting.turnId)).toEqual([{ kind: 'test-end', id: 'test-end:k-del-strt', due_at_ms: atDelete, payload: payload(starting, 'rc-del-b') }])
    expect(seen.get(live.turnId)).toEqual([{ kind: 'test-end', id: 'test-end:k-del-live', due_at_ms: atRelease, payload: payload(live, 'rc-del-a') }])
    const ids = h.sql.exec<{ id: string }>("SELECT id FROM due_tasks WHERE kind = 'test-end' ORDER BY id").toArray().map(r => r.id)
    expect(ids).toEqual(['test-end:k-del-live', 'test-end:k-del-queu', 'test-end:k-del-strt'])
  }))
})

describe('B: a turn that already ended keeps its own outcome in the payload (#168 r1, Opus 1)', () => {
  const doneThen = async (h: Harness, key: string) => {
    const a = ok(await submit(h, `rc-${key}`, key)); await settle()
    h.push(a.turnId, ev.started(), ev.text('a'), ev.checkpoint(2), finishedWith({ v: 1 }))
    expect(h.turn(a.turnId).state).toBe('ending')
    return a
  }
  const done = (key: string, a: SendTurnResult) => ({ turnId: a.turnId, runId: a.runId, chatId: `rc-${key}`, outcome: 'done', failure: null, structuredOutput: { v: 1 } })

  it('done, then a pause before released: failure null', () => inSeams(async h => {
    const seen = captureEnds(h)
    const a = await doneThen(h, 'k-donep-01')
    h.core.pause({ kind: 'person', memberId: 'm_admin' })
    h.push(a.turnId, released())
    expect(seen.get(a.turnId)!.map(x => x!.payload)).toEqual([done('k-donep-01', a)])
  }))

  it('done, then the container exits before released: failure null', () => inSeams(async h => {
    const seen = captureEnds(h)
    const a = await doneThen(h, 'k-donec-01')
    h.pool.runnerTurns.set('runner-0', [a.turnId])
    h.core.containerExited('runner-0', 1)
    for (let i = 0; i < 5 && h.turn(a.turnId).state !== 'ended'; i++) await h.tick(MIN)
    expect(seen.get(a.turnId)!.map(x => x!.payload)).toEqual([done('k-donec-01', a)])
  }))
})

describe('B: a deferral is not the turn\'s end (#168 r1 item 5, line B)', () => {
  it('a turn whose checkpoint leaves the chat waiting ensures no end task and keeps on_end_json for the resume', () => inSeams(async h => {
    const seen = captureEnds(h)
    const a = ok(await submit(h, 'rc-defer', 'k-defer-01')); await settle()
    h.push(a.turnId, ev.started(), ev.text('a'), ev.deferred(), ev.checkpoint(2), ev.success(), released())
    expect(h.turn(a.turnId)).toMatchObject({ state: 'ended', on_end_json: '{"kind":"test-end","id":"test-end:k-defer-01"}' })
    expect(h.sql.exec<{ session: string }>("SELECT session FROM chat_state WHERE chat_id = 'rc-defer'").one().session).toBe('waiting')
    expect(seen.get(a.turnId)).toEqual([null])
  }))

  it('the same shape without a deferral, and a deferral stopped before its checkpoint, both still fire', () => inSeams(async h => {
    const seen = captureEnds(h)
    const plain = ok(await submit(h, 'rc-nodefer', 'k-nodef-01')); await settle()
    h.push(plain.turnId, ev.started(), ev.text('a'), ev.checkpoint(2), ev.success(), released())
    const cut = ok(await submit(h, 'rc-defcut', 'k-defcut-1')); await settle()
    h.push(cut.turnId, ev.started(), ev.text('a'), ev.deferred())
    h.core.stop(cut.turnId, SYSTEM)
    h.push(cut.turnId, ev.failed('stopped'), ev.released(null))
    expect(seen.get(plain.turnId)!.map(x => x!.payload)).toEqual([{ turnId: plain.turnId, runId: plain.runId, chatId: 'rc-nodefer', outcome: 'done', failure: null, structuredOutput: null }])
    expect(seen.get(cut.turnId)!.map(x => x!.payload)).toEqual([{ turnId: cut.turnId, runId: cut.runId, chatId: 'rc-defcut', outcome: 'stopped', failure: null, structuredOutput: null }])
  }))
})

describe('C: structured output (failure 2, 3)', () => {
  it('the format reaches RunStart; a turn without one sends none', () => inSeams(async h => {
    const fmt = { type: 'json_schema' as const, schema: { type: 'object', properties: { s: { type: 'string' } } } }
    const a = ok(await submit(h, 'rc-fmt', 'k-fmt-001', { outputFormat: fmt })); await settle()
    const b = ok(await h.submit('c-nofmt', 'k-nofmt-1')); await settle()
    const starts = h.pool.calls.filter(c => c.method === 'place').map(c => c.args[0] as Record<string, unknown>)
    expect(starts.find(s => s.runId === a.turnId)!.outputFormat).toEqual({ type: 'json_schema', schema: { type: 'object', properties: { s: { type: 'string' } } } })
    expect(Object.hasOwn(starts.find(s => s.runId === b.turnId)!, 'outputFormat')).toBe(false)
  }))

  it('a 200 KiB answer in the StructuredOutput tool and the result message is never stored, traced or shown', () => inSeams(async h => {
    const seen = captureEnds(h)
    const big = 'Z'.repeat(200 * 1024)
    const a = ok(await submit(h, 'rc-big', 'k-big-0001')); await settle()
    h.push(a.turnId,
      ev.started(),
      { type: 'sdk', truncated: false, message: { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'tu_r', name: 'Read', input: {} },
        { type: 'tool_use', id: 'tu_so', name: 'StructuredOutput', input: { blob: big } },
      ] } } },
      { type: 'sdk', truncated: false, message: { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, structured_output: { blob: big } } },
      ev.checkpoint(2), ev.failed('structured_output'), released())
    const stored = h.sql.exec<{ json: string }>('SELECT json FROM events').toArray().map(r => r.json).join('\n')
    const traced = h.sql.exec<{ json: string }>('SELECT json FROM turn_trace').toArray().map(r => r.json).join('\n')
    // The Read step is there (the check can see steps); nothing of the answer is.
    expect(stored).toContain('Reading a file')
    for (const text of [stored, traced]) {
      expect(text).not.toContain('StructuredOutput')
      expect(text).not.toContain('ZZZZ')
    }
    expect(stored.length).toBeLessThan(4096)
    const trace = h.core.readTrace(a.turnId, { owner: 'm_system' })!
    expect(trace.steps.map(s => [s.kind, s.label, s.detail])).toEqual([['root', 'Inhouse agent', '1 question'], ['tool', 'Reading a file', 'Read']])
    expect(h.turn(a.turnId).structured_output_json).toBeNull()
    expect((seen.get(a.turnId)![0]!.payload as { failure: string; structuredOutput: unknown })).toMatchObject({ failure: 'structured_output', structuredOutput: null })
  }))
})

describe('the payload hash through the engine (failure 4)', () => {
  const FMT = { type: 'json_schema' as const, schema: { type: 'object' } }
  const base = (h: Harness, o: Partial<InternalSubmit> = {}) => submit(h, 'rc-hash', 'k-hash-001', {
    text: 'Morning check', outputFormat: FMT, onEnd: { kind: 'test-end', id: 'test-end:s1' }, ...o,
  })

  it('stores the SHA-256 of the canonical caller input (literal vector from shasum)', () => inSeams(async h => {
    const a = ok(await base(h))
    // {"attachments":[],"effort":"medium","model":"sonnet","onEnd":{"id":"test-end:s1","kind":"test-end"},
    //  "outputFormat":{"schema":{"type":"object"},"type":"json_schema"},"priority":"next","text":"Morning check"}
    expect(h.turn(a.turnId).payload_hash).toBe('e407e9da88e1afe4232abd66a85750c57c40a69a9d0f1f4f8f60a0fa1dffafcc')
  }))

  it('a byte-for-byte re-submit dedupes after a settings change; effort, outputFormat or onEnd changed is key_reused', () => inSeams(async h => {
    const first = ok(await base(h))
    // Resolved values changed (the model's API id, the side model, the turn budget, WebFetch's hosts): still a dedupe.
    expect(await base(h, { model: 'claude-opus-5-5', sideModel: 'claude-opus-5-5', maxTurns: 100, webFetchDomains: ['example.com'] })).toEqual(first)
    const reused = { refused: { code: 'conflict', reason: 'key_reused' } }
    expect(await base(h, { effort: 'high' })).toEqual(reused)
    expect(await base(h, { outputFormat: { type: 'json_schema', schema: { type: 'array' } } })).toEqual(reused)
    expect(await base(h, { outputFormat: undefined })).toEqual(reused)
    expect(await base(h, { onEnd: { kind: 'test-end', id: 'test-end:s2' } })).toEqual(reused)
    expect(await base(h, { onEnd: undefined })).toEqual(reused)
    expect(h.turns()).toHaveLength(1)
  }))
})

describe('G and A: who submits, and what the internal path refuses (failure 5)', () => {
  it('m_system owns its chat; a person and m_system never reach each other\'s chats; no one else submits as it', () => inSeams(async h => {
    const own = ok(await submit(h, 'rc-sys', 'k-sys-0001'))
    expect(h.sql.exec<{ owner_id: string }>("SELECT owner_id FROM chat_state WHERE chat_id = 'rc-sys'").one().owner_id).toBe('m_system')
    expect(await submit(h, 'rc-sys', 'k-sys-0001')).toEqual(own)
    expect(await h.submit('rc-sys', 'k-person-1')).toEqual({ refused: { code: 'not_found' } })
    ok(await h.submit('c-person', 'k-person-2'))
    expect(await submit(h, 'c-person', 'k-sys-0002')).toEqual({ refused: { code: 'not_found' } })
    expect(await submit(h, 'rc-sys2', 'k-sys-0003', { by: { kind: 'person', memberId: 'm_system' } })).toEqual({ refused: { code: 'forbidden' } })
    expect(await submit(h, 'rc-sys2', 'k-sys-0004', { by: { kind: 'inhouse', memberId: 'm_system' } })).toEqual({ refused: { code: 'forbidden' } })
    expect(await submit(h, 'rc-sys2', 'k-sys-0005', { by: { kind: 'inhouse', memberId: 'm_inhouse' } })).toEqual({ refused: { code: 'forbidden' } })
    expect(h.turns().map(t => t.owner_id).sort()).toEqual(['m_owner', 'm_system'])
  }))

  it('an attachment named twice, a bad format and an unregistered end kind are refused, with no turn', () => inSeams(async h => {
    const att = { fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA', name: 'a.pdf' }
    h.files.inputs.set('rc-dup', [{ id: att.fileId, chatId: 'rc-dup', kind: 'input', path: `inputs/${att.fileId}-a.pdf`, name: 'a.pdf', contentType: 'application/pdf', bytes: 1, sha256: 'a'.repeat(64), turnId: null }])
    const input = { clientTurnKey: 'k-dup-0001', text: 'x', priority: 'next' as const, model: 'sonnet', attachments: [att, att] }
    expect(await submit(h, 'rc-dup', 'k-dup-0001', { input })).toEqual({ refused: { code: 'invalid' } })
    // The same file once is admitted (only the duplicate refused it).
    ok(await submit(h, 'rc-dup', 'k-dup-0002', { input: { ...input, clientTurnKey: 'k-dup-0002', attachments: [att] } }))
    expect(await submit(h, 'rc-bad', 'k-badfmt-1', { outputFormat: { type: 'text' } as never })).toEqual({ refused: { code: 'invalid' } })
    expect(await submit(h, 'rc-bad', 'k-badend-1', { onEnd: { kind: 'no-such-kind', id: 'x' } })).toEqual({ refused: { code: 'invalid' } })
    expect(await submit(h, 'rc-bad', 'k-badend-2', { onEnd: { kind: 'test-end', id: '' } })).toEqual({ refused: { code: 'invalid' } })
    // An end id another kind's task holds would make the final step's ensure a no-op: refused (#168 r1, Opus 3).
    h.sched.schedule({ id: 'run-advance:held', kind: 'run-advance', dueAtMs: h.clock.now + MIN })
    expect(await submit(h, 'rc-bad', 'k-badend-3', { onEnd: { kind: 'test-end', id: 'run-advance:held' } })).toEqual({ refused: { code: 'invalid' } })
    expect(h.turns()).toHaveLength(1)
  }))
})

describe('the engine takes an end task or a format only through its extra argument (failure 6, #168 r1 nit)', () => {
  it('core.submitTurn with onEnd and outputFormat on the turn itself stores neither, sends no format and ensures no end task', () => inSeams(async h => {
    const t = {
      chatId: 'c-noextra', by: { kind: 'person' as const, memberId: MEMBER }, model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium' as const,
      sideModel: 'claude-haiku-5-5', maxTurns: 25, webFetchDomains: null,
      input: { clientTurnKey: 'k-noext-01', text: 'hi', priority: 'next' as const, model: 'sonnet', attachments: [] },
      onEnd: { kind: 'test-end', id: 'test-end:k-noext-01' }, outputFormat: { type: 'json_schema', schema: {} },
    }
    const a = ok(await h.core.submitTurn(t)); await settle()
    expect(h.turn(a.turnId)).toMatchObject({ on_end_json: null, output_format_json: null })
    const start = h.pool.calls.find(c => c.method === 'place')!.args[0] as Record<string, unknown>
    expect(Object.hasOwn(start, 'outputFormat')).toBe(false)
    h.push(a.turnId, ev.started(), ev.text('a'), ev.checkpoint(2), ev.success(), released())
    expect(h.turn(a.turnId).state).toBe('ended')
    expect(h.sql.exec("SELECT id FROM due_tasks WHERE kind = 'test-end'").toArray()).toEqual([])
  }))
})

describe('route 29\'s RPC drops what only the internal path may set (failure 6)', () => {
  it('BrandAgent.submitTurn stores neither an end task nor a format sent over RPC', async () => {
    const stub = env.BRAND_AGENT.getByName(`rpc-strip-${Math.random()}`)
    const turn = {
      chatId: 'c-rpc', by: { kind: 'person', memberId: MEMBER }, model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium',
      sideModel: 'claude-haiku-5-5', maxTurns: 25, webFetchDomains: null,
      input: { clientTurnKey: 'k-rpc-0001', text: 'hi', priority: 'next', model: 'sonnet', attachments: [] },
      onEnd: { kind: 'run-advance', id: 'run-advance:x' }, outputFormat: { type: 'json_schema', schema: {} },
    }
    const a = await stub.submitTurn(turn as never)
    expect('turnId' in a).toBe(true)
    await runInDurableObject(stub, async (_i, state) => {
      const row = state.storage.sql.exec<{ on_end_json: string | null; output_format_json: string | null }>('SELECT on_end_json, output_format_json FROM turns').one()
      expect(row).toEqual({ on_end_json: null, output_format_json: null })
    })
  })
})

describe('the three new turns columns reach an object made before them', () => {
  it('createAgentTables adds them to an older turns table, keeping its rows', () => inSeams(async h => {
    ok(await h.submit('c-old', 'k-oldrow-1'))
    for (const col of ['output_format_json', 'on_end_json', 'structured_output_json']) h.sql.exec(`ALTER TABLE turns DROP COLUMN ${col}`)
    createAgentTables(h.sql)
    const cols = h.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('turns')").toArray().map(r => r.name)
    expect(cols.slice(-3)).toEqual(['output_format_json', 'on_end_json', 'structured_output_json'])
    expect(h.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM turns').one().n).toBe(1)
  }))
})
