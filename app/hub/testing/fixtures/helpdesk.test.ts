// The helpdesk fixture (app/test/upstreams/mcp/helpdesk.ts): a Gorgias-shaped 2026-07-28 server with an API key, a
// ticket that carries an injection, mid-call input (basic/patterns/mrtr) and a tool that changes (server/tools).
import { beforeEach, describe, expect, it } from 'vitest'
import { HELPDESK_INJECTION, HELPDESK_INJECTION_TICKET, HELPDESK_KEY } from '../../../test/upstreams/mcp/helpdesk'
import type { McpFixtures } from '../../../test/upstreams/mcp/index'
import { fixtures, HELPDESK, listAll, modern, rpcOf } from './kit'

let fx: McpFixtures
beforeEach(() => {
  fx = fixtures()
})

const key = { 'X-Api-Key': HELPDESK_KEY }
const call = (name: string, args: Record<string, unknown>, opts: { params?: Record<string, unknown>; capabilities?: Record<string, unknown>; path?: string } = {}) =>
  modern(fx, `${HELPDESK}${opts.path ?? '/mcp'}`, 'tools/call', { name, arguments: args, ...opts.params }, { headers: key, capabilities: opts.capabilities })

describe('the helpdesk', () => {
  it('needs its key, lists four tools in two pages, and serves the planted injection on a read', async () => {
    expect((await modern(fx, `${HELPDESK}/mcp`, 'tools/list')).status).toBe(401)
    expect((await listAll(fx, `${HELPDESK}/mcp`, key)).map(t => t.name)).toEqual(['tickets_search', 'ticket_get', 'ticket_reply', 'macro_apply'])
    const hits = (await rpcOf(await call('tickets_search', { query: 'wholesale' }))).result!
    expect(JSON.parse((hits.content as { text: string }[])[0]!.text)).toEqual([{ id: HELPDESK_INJECTION_TICKET, subject: 'Question about wholesale pricing', status: 'open', customer: 'cy@fixture.invalid' }])
    const ticket = (await rpcOf(await call('ticket_get', { ticket_id: HELPDESK_INJECTION_TICKET }))).result!
    expect((ticket.content as { text: string }[])[0]!.text).toContain(HELPDESK_INJECTION)
    expect(fx.helpdesk.writes).toEqual([])
  })

  it('ticket_reply with no channel: -32021 for a client that declared no elicitation; a question for one that did; the answer completes it (mrtr requirement 7)', async () => {
    const none = await call('ticket_reply', { ticket_id: 1001, body: 'On its way' })
    expect(none.status).toBe(400)
    expect((await rpcOf(none)).error).toMatchObject({ code: -32021, data: { requiredCapabilities: { elicitation: { form: {} } } } })
    expect(fx.helpdesk.writes).toEqual([])
    const form = { elicitation: { form: {} } }
    const asked = await rpcOf(await call('ticket_reply', { ticket_id: 1001, body: 'On its way' }, { capabilities: form }))
    expect(asked.result).toMatchObject({ resultType: 'input_required', inputRequests: { channel: { method: 'elicitation/create', params: { mode: 'form' } } } })
    expect(fx.helpdesk.writes).toEqual([])
    const done = await rpcOf(await call('ticket_reply', { ticket_id: 1001, body: 'On its way' }, { capabilities: form, params: { inputResponses: { channel: { action: 'accept', content: { channel: 'email' } } } } }))
    expect(done.result).toMatchObject({ resultType: 'complete' })
    expect(fx.helpdesk.writes).toEqual([{ endpoint: '/mcp', tool: 'ticket_reply', args: { ticket_id: 1001, body: 'On its way', channel: 'email' } }])
    // Control: with a channel there's no question at all.
    await call('ticket_reply', { ticket_id: 1002, body: 'Refunded', channel: 'chat' })
    expect(fx.helpdesk.writes).toHaveLength(2)
  })

  it('macro_apply answers input_required with only requestState; the retry that echoes it applies the macro once (mrtr requirements 4 to 6)', async () => {
    const first = await rpcOf(await call('macro_apply', { ticket_id: 1002, macro_id: 'm-refund' }))
    expect(first.result).toMatchObject({ resultType: 'input_required' })
    expect(first.result!.inputRequests).toBeUndefined()
    expect(fx.helpdesk.writes).toEqual([])
    const forged = await rpcOf(await call('macro_apply', { ticket_id: 1002, macro_id: 'm-delay' }, { params: { requestState: first.result!.requestState } }))
    expect(forged.error!.code).toBe(-32602)
    expect(fx.helpdesk.writes).toEqual([])
    const done = await rpcOf(await call('macro_apply', { ticket_id: 1002, macro_id: 'm-refund' }, { params: { requestState: first.result!.requestState } }))
    expect(done.result).toMatchObject({ resultType: 'complete' })
    expect(fx.helpdesk.writes).toEqual([{ endpoint: '/mcp', tool: 'macro_apply', args: { ticket_id: 1002, macro_id: 'm-refund' } }])
  })

  it("/changing/mcp: ticket_reply changes when the test switches the connection, not by list count; /mcp can't be switched (#624)", async () => {
    const reply = (l: Awaited<ReturnType<typeof listAll>>) => l.find(t => t.name === 'ticket_reply')!
    const a = reply(await listAll(fx, `${HELPDESK}/changing/mcp`, key))
    expect(reply(await listAll(fx, `${HELPDESK}/changing/mcp`, key))).toEqual(a)
    expect(fx.setToolsVersion(`${HELPDESK}/changing/mcp`, 2)).toBe(true)
    const b = reply(await listAll(fx, `${HELPDESK}/changing/mcp`, key))
    expect(b.description).not.toBe(a.description)
    expect(Object.keys(b.inputSchema.properties as object)).toContain('cc')
    expect(Object.keys(a.inputSchema.properties as object)).not.toContain('cc')
    expect(fx.setToolsVersion(`${HELPDESK}/mcp`, 2)).toBe(false)
    const c = reply(await listAll(fx, `${HELPDESK}/mcp`, key))
    const d = reply(await listAll(fx, `${HELPDESK}/mcp`, key))
    expect(d).toEqual(c)
  })

  it('a revoked key is refused', async () => {
    fx.revokeKey('helpdesk')
    expect((await call('tickets_search', { query: 'x' })).status).toBe(401)
  })
})
