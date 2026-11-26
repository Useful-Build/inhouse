// The audit transport, root side, against real session processes (fixtures). Ways it could fail, written first:
// - an entry is acked before the egress's /audit/ answered 204, or acked when it failed (5xx, 401, a network error);
//   an entry that isn't posted with its run, n and the run's token;
// - two entries' acks cross, or one goes unanswered and the session's hook waits forever;
// - an entry over the cap, or one that fails the schema, reaches the stream (or crashes the root);
// - a session sends audit as a plain event, skipping the ack;
// - an entry sent after the run ended goes unanswered, so the hook waits out its timeout while the root's grace runs;
// - an entry read after the session stopped waiting for it (it sat in the pipe) is written as if its call ran;
// - the root's wall clock steps (NTP, set by hand) and an expired entry is acked, or a fresh one nacked.
// Stage 1 (N6, N14), also written first:
// - a run the Worker started at v3 gets `agentId` or `inputSha256` on either wire path (the `AuditPost` or the `audit`
//   run event): its strict schema would refuse the entry, and every call would be blocked;
// - a run started at v4 loses them (the server could no longer tell a helper's call from the main agent's);
// - a v3 start that carries a helper key is admitted.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '../../../shared/protocol/index.ts'
import { PROTOCOL_HEADER } from '../../../shared/protocol/index.ts'
import { openRun, postRun, protocolHeaders, runStart, startTestRoot, waitFor, type TestRoot } from './support/root-client.ts'
import { gate, spawnFixture } from './support/test-seams.ts'

let root: TestRoot
beforeEach(async () => {
  root = await startTestRoot(spawnFixture('fake-session.ts'))
})
afterEach(async () => {
  await root.close()
})

const ends = (events: RunEvent[]) => events.filter((e) => e.type === 'finished' || e.type === 'failed')

describe('audit entries', () => {
  it('each entry is on the stream, in order, before its ack; every ack names its own id', async () => {
    const events = await postRun(root, runStart({ prompt: 'audit:5' }))
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))
    const audits = events.filter((e) => e.type === 'audit')
    expect(audits.map((e) => e.type === 'audit' && e.entry.toolUseId)).toEqual(['toolu_0', 'toolu_1', 'toolu_2', 'toolu_3', 'toolu_4'])
    const report = events.find((e) => e.type === 'sdk' && e.message.type === 'audits')
    // The session sent each entry only after the previous one's ack: the report comes after all five entries.
    expect(report!.seq).toBeGreaterThan(audits.at(-1)!.seq)
    expect(report!.type === 'sdk' && report!.message.replies).toEqual([0, 1, 2, 3, 4].map((id) => ({ type: 'audit_ack', id })))
    expect(ends(events)).toEqual([expect.objectContaining({ type: 'finished' })])
  })

  it('each entry is posted to the egress with its run, n from 0 and the run token, before its ack', async () => {
    const start = runStart({ prompt: 'audit:3' })
    await postRun(root, start)
    expect(root.egress.audits.map((a) => [a.turnId, a.n, a.entry.toolUseId])).toEqual([
      [start.runId, 0, 'toolu_0'],
      [start.runId, 1, 'toolu_1'],
      [start.runId, 2, 'toolu_2'],
    ])
    expect(root.egress.tokens.filter((t) => t.route === 'audit').map((t) => t.token)).toEqual([start.runToken, start.runToken, start.runToken])
    expect(root.egress.tokens.every((t) => t.token === start.runToken)).toBe(true)
  })

  it("the hook isn't acked before the egress's 204", async () => {
    const start = runStart({ prompt: 'audit:1' })
    const held = gate()
    let posted = false
    root.egress.onAudit = async () => {
      posted = true
      await held.promise
      return null
    }
    const run = openRun(root, start)
    await waitFor(() => posted, 'the entry posted')
    // Many turns of the loop: the session got no reply and wrote nothing, and no audit event went out.
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r))
    expect(run.events.some((e) => e.type === 'audit' || e.type === 'sdk')).toBe(false)
    held.open()
    const events = await run.done
    const report = events.find((e) => e.type === 'sdk' && e.message.type === 'audits')
    expect(report?.type === 'sdk' && report.message.replies).toEqual([{ type: 'audit_ack', id: 0 }])
  })

  it.each([
    ['a 500', () => new Response('down', { status: 500 })],
    ['a 401', () => new Response('closed', { status: 401 })],
    ['a 200 (not 204)', () => new Response(null, { status: 200 })],
    ['a network error', () => Promise.reject(new Error('connection reset'))],
  ])('%s from /audit/ denies the call: a nack, and no audit event', async (_, answer) => {
    root.egress.onAudit = answer as () => Response
    const events = await postRun(root, runStart({ prompt: 'audit:1' }))
    expect(events.some((e) => e.type === 'audit')).toBe(false)
    const report = events.find((e) => e.type === 'sdk' && e.message.type === 'audits')
    expect(report?.type === 'sdk' && report.message.replies).toEqual([{ type: 'audit_nack', id: 0, error: 'the Worker did not record the entry' }])
  })

  it('an entry sent after the run ended gets a nack at once (the session needs no timeout, and ends in time)', async () => {
    const start = runStart({ prompt: 'audit-after-end' })
    const events = await postRun(root, start)
    expect(events.some((e) => e.type === 'audit')).toBe(false)
    await waitFor(() => root.liveCount() === 0, 'the run to end')
    const reply = JSON.parse(readFileSync(join(root.users.dirs.get(start.chatId)!, 'audit-reply.json'), 'utf8'))
    expect(reply).toEqual({ type: 'audit_nack', id: 0, error: 'the run has ended' })
  })

  it('an entry read after its expiresAt is nacked and never written', async () => {
    const events = await postRun(root, runStart({ prompt: 'audit-expired' }))
    expect(events.some((e) => e.type === 'audit')).toBe(false)
    const report = events.find((e) => e.type === 'sdk' && e.message.type === 'audits')
    expect(report!.type === 'sdk' && report!.message.replies).toEqual([{ type: 'audit_nack', id: 0, error: 'the entry expired before the root read it' }])
    expect(ends(events)).toEqual([expect.objectContaining({ type: 'finished' })])
  })

  it.each([
    ['back', -3_600_000, 'audit-expired', { type: 'audit_nack', id: 0, error: 'the entry expired before the root read it' }],
    ['forward', 3_600_000, 'audit:1', { type: 'audit_ack', id: 0 }],
  ])("the root's wall clock stepped an hour %s changes no expiry", async (_how, offset, prompt, reply) => {
    const real = Date.now.bind(Date)
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + offset)
    try {
      const events = await postRun(root, runStart({ prompt }))
      const report = events.find((e) => e.type === 'sdk' && e.message.type === 'audits')
      expect(report!.type === 'sdk' && report!.message.replies).toEqual([reply])
    } finally {
      spy.mockRestore()
    }
  })

  it('an entry that fails the schema (input over the cap) ends the session as protocol; nothing of it reaches the stream', async () => {
    const events = await postRun(root, runStart({ prompt: 'audit-bad' }))
    expect(events.some((e) => e.type === 'audit')).toBe(false)
    expect(ends(events)).toEqual([expect.objectContaining({ type: 'failed', reason: 'protocol' })])
  })
})

describe('the helper keys on the wire (v4)', () => {
  const sent = (events: RunEvent[]) => events.flatMap((e) => (e.type === 'audit' ? [e.entry] : []))
  it('a run started at v4: both entries keep agentId and inputSha256, on the AuditPost and on the audit event', async () => {
    const events = await postRun(root, runStart({ prompt: 'audit-helper' }), 4)
    const want = [
      { agentId: 'agent-7', inputSha256: '0'.repeat(64) },
      { agentId: null, inputSha256: '1'.repeat(64) },
    ]
    expect(sent(events).map((e) => ({ agentId: e.agentId, inputSha256: e.inputSha256 }))).toEqual(want)
    expect(root.egress.audits.map((a) => ({ agentId: a.entry.agentId, inputSha256: a.entry.inputSha256 }))).toEqual(want)
    expect(ends(events)).toEqual([expect.objectContaining({ type: 'finished' })])
  })

  it('a run started at v3: neither wire path carries agentId or inputSha256; the calls are still recorded and acked', async () => {
    const events = await postRun(root, runStart({ prompt: 'audit-helper' }), 3)
    for (const e of [...sent(events), ...root.egress.audits.map((a) => a.entry)]) {
      expect(e).not.toHaveProperty('agentId')
      expect(e).not.toHaveProperty('inputSha256')
    }
    expect(sent(events).map((e) => e.toolUseId)).toEqual(['toolu_0', 'toolu_1'])
    expect(root.egress.audits.map((a) => a.entry.toolUseId)).toEqual(['toolu_0', 'toolu_1'])
    const report = events.find((e) => e.type === 'sdk' && e.message.type === 'audits')
    expect(report?.type === 'sdk' && report.message.replies).toEqual([0, 1].map((id) => ({ type: 'audit_ack', id })))
  })

  it.each([
    ['agents', { agents: { researcher: { description: 'd', prompt: 'p' }, analyst: { description: 'd', prompt: 'p' } }, subagentModel: 'claude-sonnet-5-5' }],
    ['actions', { actions: false }],
  ])('a v3 start carrying %s is refused (400), never admitted; the same start at v4 is', async (_, extra) => {
    const start = runStart({ prompt: 'echo:m:1', ...extra })
    const res = await fetch(`${root.url}/runs`, { method: 'POST', headers: { ...protocolHeaders, [PROTOCOL_HEADER]: '3' }, body: JSON.stringify(start) })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/only from v4/)
    await postRun(root, { ...start, runId: `${start.runId}-v4`, chatId: `${start.chatId}-v4` }, 4)
  })
})
