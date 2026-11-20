// The audit transport, root side, against real session processes (fixtures). Ways it could fail, written first:
// - an entry is acked before it is on the Worker's stream, or acked when it never will be (the Worker gone, the run over);
// - two entries' acks cross, or one goes unanswered and the session's hook waits forever;
// - an entry over the cap, or one that fails the schema, reaches the stream (or crashes the root);
// - a session sends audit as a plain event, skipping the ack;
// - an entry sent after the run ended goes unanswered, so the hook waits out its timeout while the root's grace runs;
// - an entry read after the session stopped waiting for it (it sat in the pipe) is written as if its call ran.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEvent } from '../../../shared/protocol/index.ts'
import { openRun, postRun, runStart, startTestRoot, waitFor, type TestRoot } from './support/root-client.ts'
import { spawnFixture } from './support/test-seams.ts'

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

  it('once the Worker has hung up, an entry is refused (nack), never acked', async () => {
    const start = runStart({ prompt: 'audit-on-stop' })
    const run = openRun(root, start)
    await waitFor(() => run.events.some((e) => e.type === 'sdk' && e.message.type === 'waiting'), 'the session to have its run')
    run.hangUp()
    await run.done.catch(() => undefined)
    await waitFor(() => root.liveCount() === 0, 'the run to end')
    const reply = JSON.parse(readFileSync(join(root.users.dirs.get(start.chatId)!, 'audit-reply.json'), 'utf8'))
    expect(reply).toMatchObject({ type: 'audit_nack', id: 0 })
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

  it('an entry that fails the schema (input over the cap) ends the session as protocol; nothing of it reaches the stream', async () => {
    const events = await postRun(root, runStart({ prompt: 'audit-bad' }))
    expect(events.some((e) => e.type === 'audit')).toBe(false)
    expect(ends(events)).toEqual([expect.objectContaining({ type: 'failed', reason: 'protocol' })])
  })
})
