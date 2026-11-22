// The client's Slack notice channel calls (P5 W4). Ways they can fail: the wrong path or method, a cursor not escaped, a
// save body that isn't exactly the shared schema's (an extra key, an alerts channel outside the list), an answer the
// shared schema refuses passed on, a refusal's reason or current list lost.
import { describe, expect, test } from 'vitest'
import { AgentError } from '../types'
import { Transport } from './transport'
import { putNotifyChannels, readAvailableChannels, readNotifyChannels } from './notifications'

const LIST = { rev: 3, channels: [{ channelId: 'C0TEST0001', name: 'ops-alerts', alerts: true }] }

function server(status: number, body: unknown) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ method: init?.method ?? 'GET', path: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { transport: new Transport({ fetch }), calls }
}

describe('notice channel calls', () => {
  test('route 73 reads the list through the shared schema', async () => {
    const s = server(200, LIST)
    expect(await readNotifyChannels(s.transport)).toEqual(LIST)
    expect(s.calls).toEqual([{ method: 'GET', path: '/api/notify/channels', body: undefined }])
  })
  test('a list the schema refuses (a user id as a channel) is an unknown error, not passed on', async () => {
    const s = server(200, { rev: 1, channels: [{ channelId: 'U0TEST0001', name: 'dm', alerts: false }] })
    await expect(readNotifyChannels(s.transport)).rejects.toMatchObject({ code: 'unknown' })
  })
  test('route 74 reads a page, with the cursor escaped', async () => {
    const page = { channels: [{ channelId: 'C0TEST0003', name: 'partner', disabled: 'shared_channel' }], nextCursor: 'dGVhbQ==' }
    const s = server(200, page)
    expect(await readAvailableChannels(s.transport)).toEqual(page)
    await readAvailableChannels(s.transport, 'a+b/c=')
    expect(s.calls.map(c => c.path)).toEqual(['/api/notify/channels/available', '/api/notify/channels/available?cursor=a%2Bb%2Fc%3D'])
  })
  test('route 75 puts exactly { channelIds, alertsChannelId, ifRev }', async () => {
    const s = server(200, LIST)
    const k = await s.transport.contract()
    expect(await putNotifyChannels(s.transport, k, { channelIds: ['C0TEST0001'], alertsChannelId: 'C0TEST0001', ifRev: 2 })).toEqual(LIST)
    expect(s.calls).toEqual([{ method: 'PUT', path: '/api/notify/channels', body: { channelIds: ['C0TEST0001'], alertsChannelId: 'C0TEST0001', ifRev: 2 } }])
  })
  test('a body the schema refuses rejects with an AgentError (invalid), never a ZodError, and is never sent', async () => {
    const s = server(200, LIST)
    const k = await s.transport.contract()
    const ids51 = Array.from({ length: 51 }, (_, i) => `C1TEST${String(i).padStart(4, '0')}`)
    for (const bad of [
      { channelIds: ['C0TEST0001'], alertsChannelId: 'C0TEST0002', ifRev: 2 },
      { channelIds: ['U0TEST0001'], ifRev: 2 },
      { channelIds: ids51, ifRev: 2 },
      { channelIds: [], ifRev: 2, link_names: true },
    ]) {
      const e = await putNotifyChannels(s.transport, k, bad as never).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(AgentError)
      expect(e).toMatchObject({ code: 'invalid' })
    }
    expect(await putNotifyChannels(s.transport, k, { channelIds: ids51.slice(0, 50), ifRev: 2 })).toEqual(LIST)
    expect(s.calls.length).toBe(1)
  })
  test('a refusal keeps its reason, a stale save its current list', async () => {
    const a = server(409, { error: { code: 'conflict', reason: 'shared_channel', current: { channelId: 'C0TEST0003' } } })
    const e1 = await putNotifyChannels(a.transport, await a.transport.contract(), { channelIds: ['C0TEST0003'], ifRev: 1 }).catch((x: unknown) => x)
    expect(e1).toBeInstanceOf(AgentError)
    expect(e1).toMatchObject({ code: 'conflict', reason: 'shared_channel', current: { channelId: 'C0TEST0003' } })
    const b = server(409, { error: { code: 'conflict', current: LIST } })
    const e2 = await putNotifyChannels(b.transport, await b.transport.contract(), { channelIds: [], ifRev: 1 }).catch((x: unknown) => x)
    expect(e2).toMatchObject({ code: 'conflict', current: LIST })
    expect((e2 as AgentError).reason).toBeUndefined()
    const c = server(503, { error: { code: 'unavailable', reason: 'slack_not_connected' } })
    await expect(readAvailableChannels(c.transport)).rejects.toMatchObject({ code: 'unavailable', reason: 'slack_not_connected' })
  })

  test("HttpAgent passes a stale save's current list on only when it parses (review round 2)", async () => {
    const { HttpAgent } = await import('./client')
    const agentWith = (current: unknown) => new HttpAgent({
      fetch: async (input, init) => (String(input) === '/api/notify/channels' && init?.method === 'PUT'
        ? new Response(JSON.stringify({ error: { code: 'conflict', current } }), { status: 409, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({ error: { code: 'unavailable' } }), { status: 503, headers: { 'Content-Type': 'application/json' } })),
      now: () => 5000,
    })
    const good = await agentWith(LIST).saveNotifyChannels({ channelIds: [], ifRev: 1 }).catch((x: unknown) => x)
    expect(good).toBeInstanceOf(AgentError)
    expect(good).toMatchObject({ code: 'conflict', current: LIST })
    for (const bad of [{ rev: 'x', channels: [] }, { rev: 1, channels: [{ channelId: 'U0TEST0001', name: 'dm', alerts: false }] }, { anything: true }]) {
      const e = await agentWith(bad).saveNotifyChannels({ channelIds: [], ifRev: 1 }).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(AgentError)
      expect((e as AgentError).code).toBe('conflict')
      expect((e as AgentError).current, JSON.stringify(bad)).toBeUndefined()
    }
  })
})
