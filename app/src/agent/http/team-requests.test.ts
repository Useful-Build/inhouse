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
      ['Connect Zebra Ledger', 'New tool · sent by a teammate', 'With the team'],
      ['Add the skill "pdf"', 'New job · sent by you', 'With the team'],
      ['Something broke', 'Report a bug · sent by a teammate', 'With the team'],
    ])
    expect(s.teamRequests.map(r => r.mine)).toEqual([false, true, false])
  })

  test('a request with a title lists the title, and opens to the words in full', async () => {
    const { agent } = await loaded(reads({ requests: [rec('a', { kind: 'bug', subject: null, text: 'Export fails\n\nIt broke when I exported.', mine: true })] }))
    expect(agent.getSnapshot().teamRequests.map(r => [r.title, r.text])).toEqual([['Export fails', 'Export fails\n\nIt broke when I exported.']])
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
    // The server answers what was filed: the echo of the body.
    const echo = (r: Req) => ({ status: 201, body: rec('n', { kind: body(r).kind, subject: body(r).subject ?? null, text: body(r).text, mine: true }) })
    const { agent, calls } = await loaded({ ...reads(), 'POST /api/team-requests': echo })
    await agent.requestSkill('pdf')
    expect(body(calls.filter(c => c.method === 'POST')[0]!)).toEqual({ kind: 'job', subject: 'pdf', text: 'Add the skill "pdf"' })
    expect(agent.getSnapshot().requestedSkills).toEqual({ pdf: true })
    // A title typed in the window goes on its own line above the details; one made from the details isn't repeated; a title alone is the words.
    await agent.sendTeamRequest({ icon: 'bug_report', title: 'Export fails', sub: 's', at, status: 'Sent', kind: 'bug', text: 'It broke when I sent a long request.' })
    expect(body(calls.filter(c => c.method === 'POST')[1]!)).toEqual({ kind: 'bug', text: 'Export fails\n\nIt broke when I sent a long request.' })
    await agent.sendTeamRequest({ icon: 'bug_report', title: 'It broke again.', sub: 's', at, status: 'Sent', kind: 'bug', text: 'It broke again.' })
    expect(body(calls.filter(c => c.method === 'POST')[2]!)).toEqual({ kind: 'bug', text: 'It broke again.' })
    await agent.sendTeamRequest({ icon: 'campaign', title: 'More reports', sub: 's', at, status: 'Sent', kind: 'feedback' })
    expect(body(calls.filter(c => c.method === 'POST')[3]!)).toEqual({ kind: 'feedback', text: 'More reports' })
  })

  test('a refused request is taken back: not marked requested', async () => {
    const { agent } = await loaded({ ...reads(), 'POST /api/team-requests': refusal(403, 'forbidden', { reason: 'request_limit' }) })
    await expect(agent.requestTool('shopify', true)).rejects.toMatchObject({ code: 'forbidden' })
    expect(agent.getSnapshot().requestedTools).toEqual({})
    expect(agent.getSnapshot().teamRequests).toEqual([])
  })

  test('the 50-open refusal reads in plain words and leaves nothing marked', async () => {
    const { agent } = await loaded({ ...reads(), 'POST /api/team-requests': refusal(403, 'forbidden', { reason: 'request_limit' }) })
    await expect(agent.requestTool('shopify', true)).rejects.toMatchObject({ message: 'Your Inhouse team already has 50 open requests. Wait for an answer, or take back one of yours.' })
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

  test('a request the server merged into the person\'s open one (other words come back) is told so, and not shown as sent', async () => {
    const existing = rec('e', { kind: 'bug', subject: null, text: 'It broke when I sent a long request.', mine: true })
    const { agent } = await loaded({ ...reads(), 'POST /api/team-requests': { status: 200, body: existing } })
    const sent = agent.sendTeamRequest({ icon: 'bug_report', title: 't', sub: 's', at, status: 'Sent', kind: 'bug', text: 'Something else broke.' })
    await expect(sent).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('It broke when I sent a long request.') })
    await expect(sent).rejects.toMatchObject({ message: expect.stringContaining('already have an open request') })
  })

  test('on that conflict the returned open request joins the list and its Requested mark stays, so the page does not offer Request again', async () => {
    const existing = rec('e', { kind: 'tool', subject: 'shopify', text: 'Connect shopify', mine: true })
    const { agent } = await loaded({ ...reads(), 'POST /api/team-requests': { status: 200, body: existing } })
    await expect(agent.sendTeamRequest({ icon: 'add_link', title: 't', sub: 's', at, status: 'Sent', kind: 'tool', text: 'Connect shopify, but read-only' })).rejects.toMatchObject({ code: 'conflict' })
    // The window sends no subject; the tool button does: same person, kind and subject means the server answers the open one.
    await expect(agent.requestTool('shopify', true)).resolves.toBeUndefined()
    const open = rec('o', { kind: 'tool', subject: 'zebra', text: 'Connect zebra, first words', mine: true })
    const second = await loaded({ ...reads(), 'POST /api/team-requests': { status: 200, body: open } })
    await expect(second.agent.requestTool('zebra', true)).rejects.toMatchObject({ code: 'conflict' })
    expect(second.agent.getSnapshot().requestedTools).toEqual({ zebra: true })
    expect(second.agent.getSnapshot().teamRequests.map(r => r.title)).toEqual(['Connect zebra, first words'])
  })

  test('the different-words check ignores surrounding whitespace in what was sent', async () => {
    const { agent } = await loaded({ ...reads(), 'POST /api/team-requests': { status: 201, body: rec('n', { kind: 'bug', subject: null, text: 'It broke.', mine: true }) } })
    await expect(agent.sendTeamRequest({ icon: 'bug_report', title: 'It broke.', sub: 's', at, status: 'Sent', kind: 'bug', text: '  It broke.  ' })).resolves.toBeUndefined()
  })

  test('the names are recomputed when the members arrive after the requests', async () => {
    // The members read is held until the requests are in the snapshot, so they were first built without any name.
    const s = server({
      ...reads({ requests: [rec('a', { requestedBy: 'm_dana' })] }),
      'GET /api/members': { body: { items: [{ id: 'm_dana', name: 'Dana Example', email: 'dana@example.test', title: null, role: 'member', status: 'active', photo: null, rev: 1 }], nextCursor: null } },
    })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), 'http://x.test')
      if (url.pathname === '/api/members') await gate
      return s.fetch(input, init)
    }
    const agent = new HttpAgent({ fetch, now: () => NOW })
    // Released only once the requests are in the snapshot, so the members' read always lands after them.
    agent.subscribe(() => { if (agent.read().resources.requests.status === 'ready') release() })
    await agent.whenLoaded()
    expect(agent.getSnapshot().teamRequests.map(r => r.sub)).toEqual(['New tool · sent by Dana Example'])
  })
})
