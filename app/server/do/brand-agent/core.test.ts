// The turn engine (p3-design 4.3-4.7, 4.11) on the BrandAgent's real SQLite with the port fakes. Expected values are
// literals written here (event sequences, states, the fakes' recorded calls), never read from core.ts. Ways it can
// fail, written down first:
//  1. admission: a retried POST becomes a second turn; a refusal comes in the wrong order; an expired drain still
//     refuses (obligation 1); a removed member, a paused agent, a damaged or waiting session or a full backlog admits;
//  2. claim before await: a pause, stop or delete during `reserve`, `mint` or `place` lets the late result commit (a
//     placement after the fence, a token that leaves, a hold never given back) (obligation 2);
//  3. one writer: a chat's next turn is placed before the previous one's `released`; stop ends the queue with it;
//  4. placement answers: `rejected` doesn't fail `protocol` (7); an ambiguous answer and the real one in either order
//     double-start the turn or fail an admitted one (6); the placement hooks don't revoke, mint and place again, or a
//     pause or a stop leaves a turn in the pool's queue (9);
//  5. ingest: a duplicate is applied twice, a gap isn't a `protocol` failure, a second terminal changes the outcome, the
//     session state is wrong after checkpoint / deferred / mirror_error / no checkpoint / nothing ran (4.7), a resume
//     doesn't carry `expect` with `lastUuidIndex` (5);
//  6. the watchdog fails a turn on one `unknown` or one `unreachable`, fails an `ending` turn a second time, or leaves
//     a chat blocked; a reset leaves a turn that never starts or starts twice;
//  7. `budget_busy` holds the turn in `starting`, retries early or never fails it.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { GRACE_MS, INACTIVITY_MS, PUSH_SILENT_MS } from './core.ts'
import type { Refusal } from './ports.ts'
import { hashRunToken } from './tokens.ts'
import { MEMBER, MIN, OTHER, SEC, deferred, ev, fullAnswer, inAgent, settle, typesOf } from '../../testing/brand-agent/core-harness.ts'
import type { SendTurnResult } from '../../../shared/contract/runs.ts'

const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}
const refusal = (r: SendTurnResult | Refusal) => ('refused' in r ? r.refused : null)

describe('admission (4.3)', () => {
  it('a new chat opens a run, queues the turn and starts it at once', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-aaaa1'))
    await settle()
    expect(a.position).toBe('starting')
    expect(typesOf(h.events(a.runId))).toEqual(['run.started', 'turn.queued', 'turn.started'])
    expect(h.turn(a.turnId).state).toBe('live')
    expect(h.placed()).toEqual([a.turnId])
  }))

  it('a retried POST answers the same turn; a reused key with another payload is key_reused', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-aaaa1'))
    const again = ok(await h.submit('c1', 'key-aaaa1'))
    expect(again).toEqual(a)
    expect(refusal(await h.submit('c1', 'key-aaaa1', { text: 'something else' }))).toEqual({ code: 'conflict', reason: 'key_reused' })
    expect(h.turns()).toHaveLength(1)
  }))

  it('refuses in the design order: removed, paused, draining, session, backlog', () => inAgent(async h => {
    h.core.onMemberRemoved(OTHER)
    expect(refusal(await h.submit('c9', 'key-rem01', { member: OTHER }))).toEqual({ code: 'forbidden', reason: 'removed' })
    h.core.pause({ kind: 'person', memberId: 'm_admin' })
    expect(refusal(await h.submit('c1', 'key-pau01'))).toEqual({ code: 'forbidden', reason: 'paused' })
    h.core.resume()
    h.core.drain()
    expect(refusal(await h.submit('c1', 'key-drn01'))).toEqual({ code: 'unavailable', reason: 'draining' })
  }))

  it('an expired drain admits (the flag outlives it: obligation 1)', () => inAgent(async h => {
    h.sql.exec("INSERT INTO flags (key, value) VALUES ('draining_since_ms', ?), ('draining_until_ms', ?)", h.clock.now - 31 * MIN, h.clock.now - MIN)
    expect(ok(await h.submit('c1', 'key-exp01')).position).toBe('starting')
    h.sql.exec("UPDATE flags SET value = ? WHERE key = 'draining_until_ms'", h.clock.now + 1)
    expect(refusal(await h.submit('c2', 'key-exp02'))).toEqual({ code: 'unavailable', reason: 'draining' })
  }))

  it('a damaged or waiting session refuses sends', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-dmg01'))
    await settle()
    h.push(a.turnId, ev.started(), ev.text('hi'), ev.mirrorError(), ev.success(), ev.released(null))
    expect(refusal(await h.submit('c1', 'key-dmg02'))).toEqual({ code: 'conflict', reason: 'session_damaged' })
    const b = ok(await h.submit('c2', 'key-wai01'))
    await settle()
    h.push(b.turnId, ev.started(), ev.text('asking'), ev.deferred(), ev.checkpoint(3, 'u3', 2), ev.success(), ev.released({ mainEntries: 3, lastUuid: 'u3', lastUuidIndex: 2 }))
    expect(refusal(await h.submit('c2', 'key-wai02'))).toEqual({ code: 'conflict', reason: 'waiting_answer' })
  }))

  it('the backlog holds 10 queued turns per chat', () => inAgent(async h => {
    h.pool.placeAnswer = () => new Promise(() => {})
    ok(await h.submit('c1', 'key-q0000'))
    for (let i = 1; i <= 10; i++) expect(ok(await h.submit('c1', `key-q${String(i).padStart(4, '0')}`)).position).toBe('queued')
    expect(refusal(await h.submit('c1', 'key-q0011'))).toEqual({ code: 'rate_limited', reason: 'queue_full' })
  }))

  it('another person on the same chat id is not found', () => inAgent(async h => {
    ok(await h.submit('c1', 'key-own01'))
    expect(refusal(await h.submit('c1', 'key-oth01', { member: OTHER }))).toEqual({ code: 'not_found' })
  }))

  it('attachments come from the stored input rows, never the client names (obligation 8)', () => inAgent(async h => {
    h.files.inputs.set('c1', [{ id: 'f_AAAAAAAAAAAAAAAAAAAAAA', chatId: 'c1', kind: 'input', path: 'inputs/f_AAAAAAAAAAAAAAAAAAAAAA-real.pdf', name: 'real.pdf', contentType: 'application/pdf', bytes: 5, sha256: 'a'.repeat(64), turnId: null }])
    const a = ok(await h.submit('c1', 'key-att01', { attachments: [{ fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA', name: '../../etc/passwd' }] }))
    await settle()
    const rs = h.pool.calls.find(c => c.method === 'place')!.args[0] as { attachments: string[]; prompt: string }
    expect(rs.attachments).toEqual(['inputs/f_AAAAAAAAAAAAAAAAAAAAAA-real.pdf'])
    expect(rs.prompt).toBe('question key-att01\n\nAttached file: inputs/f_AAAAAAAAAAAAAAAAAAAAAA-real.pdf')
    const queued = h.events(a.runId).find(e => e.type === 'turn.queued')
    expect(queued).toMatchObject({ attachments: [{ fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA', name: 'real.pdf' }] })
    expect(refusal(await h.submit('c1', 'key-att02', { attachments: [{ fileId: 'f_BBBBBBBBBBBBBBBBBBBBBB', name: 'x.pdf' }] }))).toEqual({ code: 'invalid' })
  }))
})

describe('claim before await (4.2.1, 4.4)', () => {
  it('a pause during reserve: nothing is placed and the hold goes back', () => inAgent(async h => {
    const gate = deferred()
    h.core.beforeStep = async step => { if (step === 'reserve') await gate.promise }
    const a = ok(await h.submit('c1', 'key-bar01'))
    await settle()
    h.core.pause({ kind: 'person', memberId: 'm_admin' })
    gate.resolve()
    await settle()
    await h.tick(0)
    expect(h.placed()).toEqual([])
    expect(h.turn(a.turnId).state).toBe('cancelled')
    expect(h.usage.calls.map(c => c.method)).toEqual(['reserve', 'release'])
  }))

  it('a stop while the token is minted: the new token is revoked and nothing is placed (obligation 2)', () => inAgent(async h => {
    const gate = deferred()
    h.core.beforeStep = async step => { if (step === 'mint') await gate.promise }
    const a = ok(await h.submit('c1', 'key-bar02'))
    await settle()
    expect(h.core.stop(a.turnId, { kind: 'person', memberId: MEMBER })).toEqual({ ok: true })
    gate.resolve()
    await settle()
    expect(h.placed()).toEqual([])
    const rows = h.sql.exec<{ revoked_at_ms: number | null }>('SELECT revoked_at_ms FROM run_tokens WHERE turn_id = ?', a.turnId).toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].revoked_at_ms).not.toBeNull()
  }))

  it('a delete-like fence during place: the late admission is stopped on its runner', () => inAgent(async h => {
    const answer = deferred<{ admitted: string }>()
    h.pool.placeAnswer = () => answer.promise
    const a = ok(await h.submit('c1', 'key-bar03'))
    await settle()
    h.core.onMemberRemoved(MEMBER)
    answer.resolve({ admitted: 'runner-1' })
    await settle()
    expect(h.pool.calls.filter(c => c.method === 'stop').map(c => c.args)).toEqual([['runner-1', a.turnId]])
    expect(typesOf(h.events(a.runId)).filter(t => t === 'turn.started')).toEqual([])
  }))

  it('a reserve whose reply was lost: the retry asks for the same turn and the hold is not doubled', () => inAgent(async h => {
    let first = true
    const real = h.usage.reserve.bind(h.usage)
    h.usage.reserve = async t => { const r = await real(t); if (first) { first = false; throw new Error('reply lost') } return r }
    const a = ok(await h.submit('c1', 'key-bar04'))
    await settle()
    expect(h.turn(a.turnId).state).toBe('starting')
    await h.tick(3 * MIN)
    await settle()
    expect(h.usage.calls.filter(c => c.method === 'reserve').map(c => (c.args[0] as { turnId: string }).turnId)).toEqual([a.turnId, a.turnId])
    expect(h.usage.holds.get(a.turnId)).toBe(250_000)
    expect(h.turn(a.turnId).state).toBe('live')
  }))
})

describe('placement answers (obligations 6, 7, 9)', () => {
  it('rejected fails the turn protocol', () => inAgent(async h => {
    h.pool.placeAnswer = { refused: 'rejected', status: 400 }
    const a = ok(await h.submit('c1', 'key-rej01'))
    await settle()
    expect(h.events(a.runId).at(-2)).toMatchObject({ type: 'turn.finished', outcome: 'failed', reason: 'protocol' })
    expect(h.events(a.runId).at(-1)).toMatchObject({ type: 'run.finished', turns: 1 })
  }))

  it('ambiguous, then the runner pushes (admitted after all): live once, never failed', () => inAgent(async h => {
    h.pool.placeAnswer = { ambiguous: 'runner-0' }
    h.pool.statusAnswer = { state: 'live', containerGone: false }
    const a = ok(await h.submit('c1', 'key-amb01'))
    await settle()
    h.push(a.turnId, ev.started(), ev.text('hello'))
    await h.tick(0)
    expect(typesOf(h.events(a.runId)).filter(t => t === 'turn.started')).toHaveLength(1)
    h.push(a.turnId, ev.success(), ev.released(null, false))
    expect(h.turn(a.turnId)).toMatchObject({ state: 'ended', outcome: 'done' })
  }))

  it('the runner pushes before the ambiguous answer lands: the late answer changes nothing', () => inAgent(async h => {
    const answer = deferred<{ ambiguous: string }>()
    h.pool.placeAnswer = () => answer.promise
    const a = ok(await h.submit('c1', 'key-amb02'))
    await settle()
    h.push(a.turnId, ev.started(), ev.text('early'))
    answer.resolve({ ambiguous: 'runner-0' })
    await settle()
    await h.tick(0)
    expect(h.turn(a.turnId).state).toBe('live')
    expect(h.pool.calls.filter(c => c.method === 'stop')).toEqual([])
    expect(typesOf(h.events(a.runId)).filter(t => t === 'turn.started')).toHaveLength(1)
  }))

  it('an admitted answer after a push made it live starts nothing twice', () => inAgent(async h => {
    const answer = deferred<{ admitted: string }>()
    h.pool.placeAnswer = () => answer.promise
    const a = ok(await h.submit('c1', 'key-amb03'))
    await settle()
    h.push(a.turnId, ev.started())
    answer.resolve({ admitted: 'runner-2' })
    await settle()
    expect(h.turn(a.turnId)).toMatchObject({ state: 'live', runner: 'runner-2' })
    expect(typesOf(h.events(a.runId)).filter(t => t === 'turn.started')).toHaveLength(1)
  }))

  it('a late queued answer after a push made it live: the live token stays open, no pool_busy', () => inAgent(async h => {
    const answer = deferred<{ queued: true }>()
    h.pool.placeAnswer = () => answer.promise
    const a = ok(await h.submit('c1', 'key-amb05'))
    await settle()
    h.push(a.turnId, ev.started())
    answer.resolve({ queued: true })
    await settle()
    const hash = h.sql.exec<{ token_hash: string }>('SELECT token_hash FROM run_tokens WHERE turn_id = ?', a.turnId).one().token_hash
    expect(h.core.checkRunToken(hash, 'model')).toMatchObject({ turnId: a.turnId })
    expect(h.turn(a.turnId)).toMatchObject({ state: 'live', pool_queued: 0 })
    expect(h.events(a.runId).filter(e => e.type === 'notice')).toEqual([])
  }))

  it('ambiguous, then unknown twice 30 s apart: stopped there and requeued, then placed again', () => inAgent(async h => {
    h.pool.placeAnswer = { ambiguous: 'runner-0' }
    h.pool.statusAnswer = { state: 'unknown', containerGone: false }
    const a = ok(await h.submit('c1', 'key-amb04'))
    await settle()
    await h.tick(0)
    expect(h.turn(a.turnId).state).toBe('starting')
    h.pool.placeAnswer = { admitted: 'runner-1' }
    await h.tick(30 * SEC)
    await settle()
    expect(h.pool.calls.filter(c => c.method === 'stop').map(c => c.args)).toEqual([['runner-0', a.turnId]])
    expect(h.turn(a.turnId)).toMatchObject({ state: 'live', runner: 'runner-1', requeues: 1 })
  }))

  it('a turn in the placement queue: retryPlacement revokes the old token and places with a new one; expiry fails pool_full', () => inAgent(async h => {
    h.pool.placeAnswer = { queued: true }
    const a = ok(await h.submit('c1', 'key-poo01'))
    await settle()
    expect(h.turn(a.turnId).pool_queued).toBe(1)
    await h.core.retryPlacement(a.turnId)
    const tokens = h.sql.exec<{ revoked_at_ms: number | null }>('SELECT revoked_at_ms FROM run_tokens WHERE turn_id = ? ORDER BY issued_at_ms', a.turnId).toArray()
    expect(tokens.map(t => t.revoked_at_ms !== null)).toEqual([true, true])
    expect(h.placed()).toEqual([a.turnId, a.turnId])
    h.core.placementExpired(a.turnId)
    expect(h.events(a.runId).at(-2)).toMatchObject({ type: 'turn.cancelled', why: 'pool_full' })
  }))

  it('pause empties the placement queue and fails those turns paused; stop dequeues', () => inAgent(async h => {
    h.pool.placeAnswer = { queued: true }
    const a = ok(await h.submit('c1', 'key-poo02'))
    const b = ok(await h.submit('c2', 'key-poo03'))
    await settle()
    expect(h.core.stop(b.turnId, { kind: 'person', memberId: MEMBER })).toEqual({ ok: true })
    expect(h.pool.calls.filter(c => c.method === 'dequeue').map(c => c.args)).toEqual([[b.turnId]])
    h.core.pause({ kind: 'person', memberId: 'm_admin' })
    expect(h.pool.calls.some(c => c.method === 'clearQueue')).toBe(true)
    expect(h.events(a.runId).find(e => e.type === 'turn.cancelled')).toMatchObject({ why: 'paused' })
    expect(h.turn(a.turnId).state).toBe('cancelled')
  }))
})

describe('ingest and the session (4.5, 4.7)', () => {
  it('a full answer: parts, ids, outcome, resumable checkpoint, the run ends', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-ing01'))
    await settle()
    h.push(a.turnId, ev.started(), ev.tool('WebSearch'), ev.text('First.'), ev.text('Second.'), ev.checkpoint(4, 'u4', 3), ev.success())
    h.push(a.turnId, ev.released({ mainEntries: 4, lastUuid: 'u4', lastUuidIndex: 3 }))
    const evs = h.events(a.runId)
    expect(typesOf(evs)).toEqual(['run.started', 'turn.queued', 'turn.started', 'step', 'part', 'part', 'turn.finished', 'run.finished'])
    expect(evs.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(evs[3]).toMatchObject({ stepId: `${a.turnId}.s0`, label: 'Searching the web', tool: 'WebSearch' })
    expect(evs[4]).toMatchObject({ messageId: `${a.turnId}.0`, part: { type: 'text', text: 'First.' }, model: 'sonnet' })
    expect(evs[5]).toMatchObject({ messageId: `${a.turnId}.1` })
    expect(evs[6]).toMatchObject({ outcome: 'done' })
    const cs = h.sql.exec('SELECT session, checkpoint_main_entries AS m, checkpoint_last_uuid AS u, checkpoint_last_uuid_index AS i FROM chat_state').one()
    expect({ ...cs }).toEqual({ session: 'resumable', m: 4, u: 'u4', i: 3 })
  }))

  it('a duplicated or split batch applies once; a gap fails protocol and asks the runner to stop', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-ing02'))
    await settle()
    const e0 = { ...ev.started(), runId: a.turnId, seq: 0 }
    const e1 = { ...ev.text('once'), runId: a.turnId, seq: 1 }
    expect(h.core.ingest(a.turnId, [e0, e1] as never)).toEqual({ ackSeq: 1, stop: false })
    expect(h.core.ingest(a.turnId, [e0, e1] as never)).toEqual({ ackSeq: 1, stop: false })
    expect(h.events(a.runId).filter(e => e.type === 'part')).toHaveLength(1)
    const e3 = { ...ev.text('gap'), runId: a.turnId, seq: 3 }
    expect(h.core.ingest(a.turnId, [e3] as never)).toEqual({ ackSeq: 1, stop: true })
    expect(h.events(a.runId).at(-1)).toMatchObject({ type: 'turn.finished', outcome: 'failed', reason: 'protocol' })
  }))

  it('terminal once: a second terminal changes nothing', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-ing03'))
    await settle()
    h.push(a.turnId, ev.started(), ev.text('x'), ev.finished('error_max_turns'), ev.success())
    expect(h.turn(a.turnId)).toMatchObject({ state: 'ending', outcome: 'failed', failure: 'max_turns' })
    expect(h.events(a.runId).filter(e => e.type === 'turn.finished')).toHaveLength(1)
  }))

  it('mainEntries 0 leaves the session none; the next turn starts a fresh session', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-ing04'))
    await settle()
    h.push(a.turnId, ev.started(), ev.text('x'), ev.checkpoint(0), ev.success(), ev.released({ mainEntries: 0, lastUuid: null, lastUuidIndex: null }))
    const b = ok(await h.submit('c1', 'key-ing05'))
    await settle()
    const starts = h.pool.calls.filter(c => c.method === 'place').map(c => c.args[0] as { sessionId: string; resume: boolean; expect: unknown })
    expect(starts.map(s => [s.sessionId, s.resume, s.expect])).toEqual([
      ['00000000-0000-4000-8000-000000000001', false, null],
      ['00000000-0000-4000-8000-000000000002', false, null],
    ])
    expect(b.position).toBe('starting')
  }))

  it('a resume carries expect with lastUuidIndex (obligation 5)', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-ing06'))
    await settle()
    h.push(a.turnId, ...fullAnswer('one', 6))
    ok(await h.submit('c1', 'key-ing07'))
    await settle()
    const rs = h.pool.calls.filter(c => c.method === 'place')[1].args[0] as { sessionId: string; resume: boolean; expect: unknown }
    expect(rs).toMatchObject({ sessionId: '00000000-0000-4000-8000-000000000001', resume: true, expect: { mainEntries: 6, lastUuid: 'u6', lastUuidIndex: 5 } })
  }))

  it('the query ran and the turn released with no checkpoint at all: damaged', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-ing08'))
    await settle()
    h.push(a.turnId, ev.started(), ev.text('x'), ev.success(), ev.released(null, true))
    expect(h.sql.exec('SELECT session FROM chat_state').one().session).toBe('damaged')
    expect(h.events(a.runId).some(e => e.type === 'notice' && e.code === 'session_damaged')).toBe(true)
  }))

  it('a stop during the file restore (nothing ran) keeps the session resumable', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-ing09'))
    await settle()
    h.push(a.turnId, ...fullAnswer('one', 2))
    const b = ok(await h.submit('c1', 'key-ing10'))
    await settle()
    h.push(b.turnId, ev.started(), ev.failed('stopped'), ev.released(null, false))
    expect(h.sql.exec('SELECT session, checkpoint_main_entries AS m FROM chat_state').one()).toMatchObject({ session: 'resumable', m: 2 })
    // A root timeout before the query: the same.
    const c = ok(await h.submit('c1', 'key-ing11'))
    await settle()
    h.push(c.turnId, ev.started(), ev.failed('timeout'), ev.released(null, false))
    expect(h.sql.exec('SELECT session FROM chat_state').one().session).toBe('resumable')
    expect(h.turn(c.turnId)).toMatchObject({ outcome: 'failed', failure: 'timeout' })
  }))

  it('a file saved is confirmed, then shown, before the run ends', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-fil01'))
    await settle()
    const sha = 'b'.repeat(64)
    h.files.pending.set(`c1 ${a.turnId} outputs/report.csv ${sha}`, { id: 'f_CCCCCCCCCCCCCCCCCCCCCC', chatId: 'c1', kind: 'output', path: 'outputs/report.csv', name: 'report.csv', contentType: 'text/csv', bytes: 10, sha256: sha, turnId: a.turnId })
    h.push(a.turnId, ev.started(), ev.text('done'), ev.fileSaved('outputs/report.csv', sha), ev.checkpoint(2, null, null), ev.success(), ev.released({ mainEntries: 2, lastUuid: null, lastUuidIndex: null }))
    await settle()
    expect(typesOf(h.events(a.runId)).slice(-3)).toEqual(['turn.finished', 'file', 'run.finished'])
  }))
})

describe('handoff, interrupt and stop (4.3, 4.6)', () => {
  it('the next turn is placed only after the previous one released', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-hnd01'))
    await settle()
    const b = ok(await h.submit('c1', 'key-hnd02'))
    await settle()
    expect(b.position).toBe('queued')
    h.push(a.turnId, ev.started(), ev.text('a'), ev.checkpoint(2, null, null), ev.success())
    await settle()
    expect(h.placed()).toEqual([a.turnId])
    h.push(a.turnId, ev.released({ mainEntries: 2, lastUuid: null, lastUuidIndex: null }))
    await settle()
    expect(h.placed()).toEqual([a.turnId, b.turnId])
    expect(b.runId).toBe(a.runId)
  }))

  it('queued turns start now first, then next, then later; FIFO within one priority', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-pri00'))
    await settle()
    const later = ok(await h.submit('c1', 'key-pri01', { priority: 'later' }))
    const next1 = ok(await h.submit('c1', 'key-pri02'))
    const next2 = ok(await h.submit('c1', 'key-pri03'))
    const now = ok(await h.submit('c1', 'key-pri04', { priority: 'now' }))
    let live = a.turnId
    for (let i = 0; i < 5; i++) {
      h.push(live, ev.started(), ev.checkpoint(2, null, null), ev.success(), ev.released({ mainEntries: 2, lastUuid: null, lastUuidIndex: null }))
      await settle()
      const row = h.turns().find(t => t.state === 'live')
      if (!row) break
      live = row.turn_id
    }
    expect(h.placed()).toEqual([a.turnId, now.turnId, next1.turnId, next2.turnId, later.turnId])
  }))

  it('stop ends that turn only: the queue carries on', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-stp01'))
    await settle()
    const b = ok(await h.submit('c1', 'key-stp02'))
    expect(h.core.stop(a.turnId, { kind: 'person', memberId: MEMBER })).toEqual({ ok: true })
    expect(h.pool.calls.filter(c => c.method === 'stop').map(c => c.args)).toEqual([['runner-0', a.turnId]])
    h.push(a.turnId, ev.failed('stopped'), ev.released({ mainEntries: 2, lastUuid: null, lastUuidIndex: null }, true))
    await settle()
    expect(h.turn(a.turnId)).toMatchObject({ state: 'ended', outcome: 'stopped' })
    expect(h.turn(b.turnId).state).toBe('live')
    expect(h.core.stop(a.turnId, { kind: 'person', memberId: MEMBER })).toEqual({ refused: { code: 'conflict', reason: 'turn_ended' } })
    expect(h.core.stop(b.turnId, { kind: 'person', memberId: OTHER })).toEqual({ refused: { code: 'not_found' } })
  }))

  it('interrupt asks the runner; a success after it is interrupted; now-priority interrupts the live turn', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-int01'))
    await settle()
    expect(h.core.interrupt(a.turnId, { kind: 'person', memberId: MEMBER })).toEqual({ ok: true })
    h.push(a.turnId, ev.started(), ev.text('partial'), ev.finished('error_during_execution'), ev.released(null, true))
    expect(h.turn(a.turnId)).toMatchObject({ outcome: 'interrupted' })
    const b = ok(await h.submit('c2', 'key-int02'))
    await settle()
    ok(await h.submit('c2', 'key-int03', { priority: 'now' }))
    expect(h.pool.calls.filter(c => c.method === 'interrupt').map(c => c.args)).toEqual([['runner-0', a.turnId], ['runner-0', b.turnId]])
  }))
})

describe('pause with live turns (N2)', () => {
  it('the grace ingests checkpoint and released; no chat ends damaged; resume starts nothing', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-ps001'))
    const b = ok(await h.submit('c2', 'key-ps002'))
    await settle()
    h.push(a.turnId, ev.started(), ev.text('a'))
    h.push(b.turnId, ev.started(), ev.text('b'))
    const q = ok(await h.submit('c1', 'key-ps003'))
    h.core.pause({ kind: 'inhouse', memberId: 'm_inhouse' })
    expect(h.turn(q.turnId).state).toBe('cancelled')
    expect(h.push(a.turnId, ev.text('dropped'), ev.checkpoint(3, null, null))).toEqual({ ackSeq: 3, stop: true })
    h.push(a.turnId, ev.failed('stopped'), ev.released({ mainEntries: 3, lastUuid: null, lastUuidIndex: null }))
    h.push(b.turnId, ev.released({ mainEntries: 2, lastUuid: 'u', lastUuidIndex: 1 }))
    expect(h.sql.exec('SELECT session FROM chat_state ORDER BY chat_id').toArray().map(r => r.session)).toEqual(['resumable', 'resumable'])
    expect(h.events(a.runId).filter(e => e.type === 'part')).toHaveLength(1)
    expect(h.core.resume()).toEqual({ paused: false, at: null, by: null })
    await h.tick(MIN)
    expect(h.turns().filter(t => t.state === 'starting' || t.state === 'live')).toEqual([])
  }))

  it('a fenced turn whose runner never answers ends at the grace, damaged only if its query ran', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-ps004'))
    await settle()
    h.push(a.turnId, ev.started(), ev.text('a'))
    h.core.pause({ kind: 'person', memberId: 'm_admin' })
    await h.tick(GRACE_MS)
    expect(h.turn(a.turnId).state).toBe('ended')
    expect(h.sql.exec('SELECT session FROM chat_state').one().session).toBe('damaged')
  }))
})

describe('the watchdog (1.3)', () => {
  it('pushes stop at minute 16: unknown twice 30 s apart → one session_crashed, the chat free', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-wd001'))
    await settle()
    for (let m = 0; m < 16; m++) { await h.tick(MIN); h.push(a.turnId, ev.text(`m${m}`)) }
    h.pool.statusAnswer = { state: 'unknown', containerGone: false }
    await h.tick(PUSH_SILENT_MS)
    expect(h.turn(a.turnId).state).toBe('live')
    await h.tick(30 * SEC)
    expect(h.events(a.runId).filter(e => e.type === 'turn.finished')).toEqual([expect.objectContaining({ outcome: 'failed', reason: 'session_crashed' })])
    await h.tick(GRACE_MS)
    expect(h.turn(a.turnId).state).toBe('ended')
    // The query ran and no checkpoint came: damaged (4.7); the chat isn't blocked: its owner's reset frees it.
    expect(refusal(await h.submit('c1', 'key-wd002'))).toEqual({ code: 'conflict', reason: 'session_damaged' })
    expect(h.core.resetSession('c1', { kind: 'person', memberId: MEMBER })).toEqual({ ok: true })
    expect(ok(await h.submit('c1', 'key-wd002')).position).toBe('starting')
  }))

  it('a single unreachable fails nothing; two with the container gone fail it', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-wd003'))
    await settle()
    h.pool.statusAnswer = { state: 'unreachable', containerGone: false }
    await h.tick(PUSH_SILENT_MS)
    await h.tick(30 * SEC)
    expect(h.turn(a.turnId).state).toBe('live')
    h.pool.statusAnswer = { state: 'unreachable', containerGone: true }
    await h.tick(30 * SEC)
    await h.tick(30 * SEC)
    expect(h.turn(a.turnId)).toMatchObject({ state: 'ending', failure: 'session_crashed' })
  }))

  it('an ending turn the runner no longer knows ends with its stored outcome, not a second failure', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-wd004'))
    await settle()
    h.push(a.turnId, ev.started(), ev.text('x'), ev.checkpoint(2, null, null), ev.success())
    h.pool.statusAnswer = { state: 'unknown', containerGone: false }
    await h.tick(90 * SEC)
    expect(h.turn(a.turnId)).toMatchObject({ state: 'ended', outcome: 'done', failure: null })
    expect(h.events(a.runId).filter(e => e.type === 'turn.finished')).toHaveLength(1)
  }))

  it('12 minutes without progress (heartbeats only) fences with timeout', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-wd005'))
    await settle()
    h.push(a.turnId, ev.started())
    for (let s = 0; s < INACTIVITY_MS; s += 30 * SEC) { await h.tick(30 * SEC); h.push(a.turnId, ev.heartbeat()) }
    expect(h.turn(a.turnId)).toMatchObject({ state: 'ending', failure: 'timeout' })
  }))
})

describe('resets (N3)', () => {
  it('a reset during reserve: after seeds the turn starts once and the chat is free', () => inAgent(async h => {
    h.core.beforeStep = async step => { if (step === 'reserve') await new Promise(() => {}) }
    const a = ok(await h.submit('c1', 'key-rs001'))
    await settle()
    const h2 = h.restart()
    await h2.tick(0)
    await settle()
    expect(h2.placed()).toEqual([a.turnId])
    expect(h2.turn(a.turnId).state).toBe('live')
  }))

  it('a reset between ended and the next start: the queued turn starts once', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-rs002'))
    await settle()
    const b = ok(await h.submit('c1', 'key-rs003'))
    h.core.beforeStep = async step => { if (step === 'reserve') await new Promise(() => {}) }
    h.push(a.turnId, ...fullAnswer('a', 2))
    expect(h.turn(b.turnId).state).toBe('starting')
    const h2 = h.restart()
    await h2.tick(0)
    await settle()
    expect(h2.placed()).toEqual([a.turnId, b.turnId])
    expect(h2.turn(b.turnId).state).toBe('live')
  }))

  it('a reset after the claim with a placement made: the ambiguous path, never another runner', () => inAgent(async h => {
    h.pool.placeAnswer = () => new Promise(() => {})
    const a = ok(await h.submit('c1', 'key-rs004'))
    await settle()
    h.sql.exec("UPDATE turns SET runner = 'runner-0' WHERE turn_id = ?", a.turnId)   // the real pool writes it before its await
    const h2 = h.restart()
    h2.pool.statusAnswer = { state: 'unknown', containerGone: false }
    h2.pool.placeAnswer = { admitted: 'runner-1' }
    await h2.tick(0)
    expect(h2.pool.calls.filter(c => c.method === 'stop').map(c => c.args)).toEqual([['runner-0', a.turnId]])
    await h2.tick(30 * SEC)
    await settle()
    expect(h2.turn(a.turnId)).toMatchObject({ state: 'live', runner: 'runner-1' })
  }))

  it('a drain with a queued follow-up: nothing starts during it; after warm-up the follow-up starts', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-dr001'))
    await settle()
    const b = ok(await h.submit('c1', 'key-dr002'))
    h.core.drain()
    h.push(a.turnId, ...fullAnswer('a', 2))
    expect(h.turn(b.turnId).state).toBe('queued')
    expect(h.dueTasks().map(t => t.id)).toContain(`run-advance:${a.runId}`)
    await h.core.warmup()
    await h.tick(0)
    await settle()
    expect(h.placed()).toEqual([a.turnId, b.turnId])
  }))
})

describe('budget_busy (4.4 step 2)', () => {
  it('back to queued, retried 15 s later, failed after 2 minutes of waiting', () => inAgent(async h => {
    h.usage.reserveAnswer = { refused: 'budget_busy' }
    const a = ok(await h.submit('c1', 'key-bud01'))
    await settle()
    expect(h.turn(a.turnId)).toMatchObject({ state: 'queued' })
    expect(h.events(a.runId).filter(e => e.type === 'notice')).toEqual([expect.objectContaining({ code: 'budget_busy' })])
    await h.tick(14 * SEC)
    expect(h.usage.calls.filter(c => c.method === 'reserve')).toHaveLength(1)
    await h.tick(SEC)
    expect(h.usage.calls.filter(c => c.method === 'reserve')).toHaveLength(2)
    for (let i = 0; i < 8; i++) await h.tick(15 * SEC)
    expect(h.turn(a.turnId)).toMatchObject({ state: 'ended', outcome: 'failed', failure: 'budget_busy' })
  }))

  it('cap_reached cancels the turn with a notice', () => inAgent(async h => {
    h.usage.reserveAnswer = { refused: 'cap_reached' }
    const a = ok(await h.submit('c1', 'key-bud02'))
    await settle()
    expect(typesOf(h.events(a.runId))).toEqual(['run.started', 'turn.queued', 'notice', 'turn.cancelled', 'run.finished'])
  }))
})

describe('tokens, count_tokens and the audit row', () => {
  it('a live turn has an open token; at ended every route is closed; long-expired rows are pruned (obligation 4)', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-tok01'))
    await settle()
    const hash = h.sql.exec<{ token_hash: string }>('SELECT token_hash FROM run_tokens WHERE turn_id = ?', a.turnId).one().token_hash
    expect(h.core.checkRunToken(hash, 'model')).toMatchObject({ turnId: a.turnId, chatId: 'c1', memberId: MEMBER })
    h.push(a.turnId, ev.started(), ev.success())
    expect(h.core.checkRunToken(hash, 'model')).toEqual({ refused: 'closed' })
    expect(h.core.checkRunToken(hash, 'events')).toMatchObject({ turnId: a.turnId })
    h.push(a.turnId, ev.released(null, false))
    expect(h.core.checkRunToken(hash, 'events')).toEqual({ refused: 'closed' })
    h.clock.now += 45 * MIN + 24 * 60 * MIN + 1
    const b = ok(await h.submit('c2', 'key-tok02'))
    await settle()
    h.push(b.turnId, ev.started(), ev.success(), ev.released(null, false))
    expect(h.core.checkRunToken(hash, 'events')).toEqual({ refused: 'unknown' })
    expect(await hashRunToken('x')).toHaveLength(64)
  }))

  it('count_tokens counts on the turn row, 50 at most', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-cnt01'))
    const answers = Array.from({ length: 51 }, () => h.core.noteCountTokens(a.turnId))
    expect(answers.filter(Boolean)).toHaveLength(50)
    expect(answers[50]).toBe(false)
  }))

  it('writeToolCall writes the redacted row once', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-aud01'))
    const entry = { hook: 'PreToolUse', toolName: 'WebFetch', toolUseId: 'tu_1', decision: 'allow', input: { url: 'https://example.test/' } }
    await h.core.writeToolCall(a.turnId, 0, entry)
    await h.core.writeToolCall(a.turnId, 0, { ...entry, decision: 'deny' })
    const rows = (await env.DB.prepare('SELECT * FROM tool_calls WHERE turn_id = ?').bind(a.turnId).all()).results
    // sha256('{"url":"https://example.test/"}'), computed outside this code.
    expect(rows).toEqual([expect.objectContaining({ n: 0, chat_id: 'c1', member_id: MEMBER, hook: 'PreToolUse', tool: 'WebFetch', decision: 'allow', input_bytes: 31, input_sha256: 'adcda36e7e491755172fab765e4ce4c026677ceec109930865bdfbae9f733614' })])
    expect(JSON.stringify(rows)).not.toContain('example.test')
  }))
})
