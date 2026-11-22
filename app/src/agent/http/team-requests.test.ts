// Requests to the Inhouse team over a fake `fetch` (P6a W3, routes 80, 81 and 83). Ways it could show a person the wrong
// thing, written down first:
//  - "Requested" on a tool or skill that has no open request, or missing on one that has;
//  - Request sent as the wrong kind or subject, or the team window's words lost on the way (text, kind);
//  - Undo that doesn't withdraw the caller's own request (or withdraws someone else's);
//  - a refused request left showing as sent.
import { describe, expect, test } from 'vitest'
import { HttpAgent } from './client'
import { reads, refusal, server } from './testing/fake-server'
import type { Req, Routes } from './testing/fake-server'

const NOW = Date.UTC(2026, 5, 1, 12)
const at = { iso: new Date(NOW - 3_600_000).toISOString(), ms: NOW - 3_600_000 }
const rec = (id: string, o: Record<string, unknown> = {}) => ({
  id: `tr_${id.padEnd(22, 'A')}`, kind: 'tool', subject: 'zebra', text: 'Connect Zebra Ledger', requestedBy: 'm_x', mine: false, status: 'open', at, updatedAt: at, rev: 1, ...o,
})
const body = (r: Req) => JSON.parse(r.body ?? 'null') as Record<string, unknown>

async function loaded(routes: Routes) {
  const s = server(routes)
  const agent = new HttpAgent({ fetch: s.fetch, now: () => NOW })
  await agent.whenLoaded()
  return { agent, ...s }
}

describe('the client: requests to the Inhouse team', () => {
  test('boots with the open requests: Requested marks from their subjects, and the window\'s list', async () => {
    const { agent } = await loaded(reads({ requests: [rec('a', { subject: 'zebra' }), rec('b', { kind: 'job', subject: 'pdf', text: 'Add the skill "pdf"', mine: true }), rec('c', { kind: 'bug', subject: null, text: 'Something broke' })] }))
    const s = agent.getSnapshot()
    expect(s.requestedTools).toEqual({ zebra: true })
    expect(s.requestedSkills).toEqual({ pdf: true })
    expect(s.teamRequests.map(r => [r.title, r.sub, r.status])).toEqual([
      ['Connect Zebra Ledger', 'New tool · sent by a teammate', 'Sent'],
      ['Add the skill "pdf"', 'New job · sent by you', 'Sent'],
      ['Something broke', 'Report a bug · sent by a teammate', 'Sent'],
    ])
  })

  test('requestTool posts a tool request with the tool as subject and a readable text, and marks it requested', async () => {
    const { agent, calls } = await loaded({ ...reads(), 'POST /api/team-requests': { status: 201, body: rec('n', { subject: 'shopify', text: 'Connect shopify', mine: true }) } })
    await agent.requestTool('shopify', true)
    const post = calls.find(c => c.method === 'POST')!
    expect(post.path).toBe('/api/team-requests')
    expect(body(post)).toEqual({ kind: 'tool', subject: 'shopify', text: 'Connect shopify' })
    expect(agent.getSnapshot().requestedTools).toEqual({ shopify: true })
  })

  test('requestTool(key, false) withdraws the caller\'s own open request, with its rev, and not another person\'s', async () => {
    const mine = rec('m', { subject: 'shopify', mine: true, rev: 3 })
    const theirs = rec('t', { subject: 'zebra', mine: false })
    const { agent, calls } = await loaded({ ...reads({ requests: [mine, theirs] }), [`PUT /api/team-requests/${mine.id}/withdrawn`]: { body: { ...mine, status: 'withdrawn', rev: 4 } } })
    await agent.requestTool('shopify', false)
    const put = calls.find(c => c.method === 'PUT')!
    expect(put.path).toBe(`/api/team-requests/${mine.id}/withdrawn`)
    expect(body(put)).toEqual({ ifRev: 3 })
    expect(agent.getSnapshot().requestedTools).toEqual({ zebra: true })
    // Someone else's request is never withdrawn from here: nothing is sent, and its "Requested" mark stays.
    const before = calls.length
    await agent.requestTool('zebra', false)
    expect(calls.length).toBe(before)
    expect(agent.getSnapshot().requestedTools).toEqual({ zebra: true })
  })

  test('requestSkill posts a job about the skill; sendTeamRequest posts the window\'s type and words', async () => {
    const { agent, calls } = await loaded({ ...reads(), 'POST /api/team-requests': { status: 201, body: rec('n', { kind: 'job', subject: 'pdf', mine: true }) } })
    await agent.requestSkill('pdf')
    expect(body(calls.filter(c => c.method === 'POST')[0]!)).toEqual({ kind: 'job', subject: 'pdf', text: 'Add the skill "pdf"' })
    expect(agent.getSnapshot().requestedSkills).toEqual({ pdf: true })
    await agent.sendTeamRequest({ icon: 'bug_report', title: 't', sub: 's', at, status: 'Sent', kind: 'bug', text: 'It broke when I sent a long request.' })
    expect(body(calls.filter(c => c.method === 'POST')[1]!)).toEqual({ kind: 'bug', text: 'It broke when I sent a long request.' })
  })

  test('a refused request is taken back: not marked requested', async () => {
    const { agent } = await loaded({ ...reads(), 'POST /api/team-requests': refusal(403, 'forbidden', { reason: 'request_limit' }) })
    await expect(agent.requestTool('shopify', true)).rejects.toMatchObject({ code: 'forbidden' })
    expect(agent.getSnapshot().requestedTools).toEqual({})
    expect(agent.getSnapshot().teamRequests).toEqual([])
  })

  test('the 50-open refusal reads in plain words and leaves nothing marked', async () => {
    const { agent } = await loaded({ ...reads(), 'POST /api/team-requests': refusal(403, 'forbidden', { reason: 'request_limit' }) })
    await expect(agent.requestTool('shopify', true)).rejects.toMatchObject({ message: 'Your Inhouse team already has 50 open requests from you. Take one back or wait for an answer.' })
    expect(agent.getSnapshot().requestedTools).toEqual({})
  })

  test('the open requests have a resource status: ready on load, error on a failed read, Retry recovers, refresh reads again', async () => {
    let n = 0
    const { agent, calls } = await loaded({ ...reads(), 'GET /api/team-requests?status=open': () => (++n === 1 ? refusal(503, 'unavailable') : { body: { items: [rec('a')] } }) })
    expect(agent.read().resources.requests).toMatchObject({ status: 'error' })
    await agent.retry('requests')
    expect(agent.read().resources.requests).toEqual({ status: 'ready' })
    expect(agent.getSnapshot().requestedTools).toEqual({ zebra: true })
    const reads_ = () => calls.filter(c => c.path === '/api/team-requests?status=open').length
    const before = reads_()
    await agent.refresh('requests')
    expect(reads_()).toBe(before + 1)
  })

  test('the requests\' names come from the members once they are read, whichever read lands last', async () => {
    const { agent } = await loaded({
      ...reads({ requests: [rec('a', { requestedBy: 'm_dana' })] }),
      'GET /api/members': { body: { items: [{ id: 'm_dana', name: 'Dana Example', email: 'dana@example.test', title: null, role: 'member', status: 'active', photo: null, rev: 1 }], nextCursor: null } },
    })
    expect(agent.getSnapshot().teamRequests.map(r => r.sub)).toEqual(['New tool · sent by Dana Example'])
  })

  test('the Inhouse team\'s list has no requester: the line says "a teammate"', async () => {
    const { requestedBy: _drop, ...bare } = rec('a')
    const { agent } = await loaded(reads({ requests: [bare] }))
    expect(agent.getSnapshot().teamRequests.map(r => r.sub)).toEqual(['New tool · sent by a teammate'])
  })
})
