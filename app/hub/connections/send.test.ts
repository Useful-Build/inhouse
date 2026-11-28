// The one guarded hop (connections/send.ts, Stage 1 M4-R1, N35; #729, #732). Ways it could go wrong, written first: the
// per-hop destination check dropped (a request to another address than the binding's still leaves); a never-sent
// header (a forwarding header, a cookie) passed on, or silently stripped; the DNS verdict or the abort ignored after the
// address check's await; an object operation, a revocation or detect handed something that isn't this hop.
import { describe, expect, it } from 'vitest'
import type { ConnectionDestinations } from '../index/contract'
import type { Upstream } from '../oauth/http'
import { guardedSender, sendHop, type Hop } from './send'
import { destinations } from './testing/kit'

const D: ConnectionDestinations = destinations('https://mcp.example.com/mcp', { token: 'https://login.example.com/token', metadata: ['https://mcp.example.com/.well-known/oauth-protected-resource'], revoke: 'https://login.example.com/revoke' })

function recording(): { base: Upstream; sent: Request[] } {
  const sent: Request[] = []
  return { sent, base: async req => (sent.push(req), new Response('ok')) }
}
const hop = (base: Upstream, extra: Partial<Hop> = {}): Hop => ({ destinations: D, purpose: 'mcp', cls: 'key', resolvePublic: async () => true, base, ...extra })

describe('sendHop: every hop', () => {
  it('the control: the binding\'s own address for the class leaves once, with redirect manual', async () => {
    const r = recording()
    expect((await sendHop(hop(r.base), new Request(D.mcp, { method: 'POST', body: '{}', headers: { 'X-Api-Key': 'k' } }))).ok).toBe(true)
    expect(r.sent.length).toBe(1)
    expect(r.sent[0]!.redirect).toBe('manual')
    expect(r.sent[0]!.headers.get('X-Api-Key')).toBe('k')
  })

  it('a request to any address but the binding\'s for its purpose and class is refused before it leaves', async () => {
    const r = recording()
    for (const url of [D.token!, D.metadata[0]!, 'https://mcp.example.com/other', 'https://evil.example.net/mcp']) {
      expect(await sendHop(hop(r.base), new Request(url, { method: 'POST', body: '{}' })), url).toMatchObject({ ok: false })
    }
    // A key named for another purpose is refused by class, even at that purpose's own address.
    expect(await sendHop(hop(r.base, { purpose: 'token' }), new Request(D.token!, { method: 'POST' }))).toEqual({ ok: false, refusal: 'class' })
    expect(r.sent).toEqual([])
  })

  it('a never-sent header (forwarding, cookie, proxy auth) refuses the hop: nothing leaves, nothing is stripped silently', async () => {
    const r = recording()
    for (const h of ['X-Forwarded-For', 'x-forwarded-host', 'Forwarded', 'Cookie', 'X-Real-IP', 'Proxy-Authorization']) {
      expect(await sendHop(hop(r.base), new Request(D.mcp, { method: 'POST', headers: { [h]: 'x' } })), h).toEqual({ ok: false, refusal: 'never_sent' })
    }
    expect(r.sent).toEqual([])
  })

  it('the DNS verdict and the abort are read after the address check\'s await; the last check runs right before the send', async () => {
    const r = recording()
    expect(await sendHop(hop(r.base, { resolvePublic: async () => false }), new Request(D.mcp, { method: 'POST' }))).toEqual({ ok: false, refusal: 'dns' })
    const controller = new AbortController()
    const aborting = hop(r.base, { resolvePublic: async () => (controller.abort(), true) })
    expect(await sendHop(aborting, new Request(D.mcp, { method: 'POST', signal: controller.signal }))).toEqual({ ok: false, refusal: 'aborted' })
    let closed = false
    expect(await sendHop(hop(r.base, { resolvePublic: async () => ((closed = true), true), closed: () => closed }), new Request(D.mcp, { method: 'POST' }))).toEqual({ ok: false, refusal: 'aborted' })
    expect(await sendHop(hop(r.base, { lastCheck: () => false }), new Request(D.mcp, { method: 'POST' }))).toEqual({ ok: false, refusal: 'stopped' })
    expect(r.sent).toEqual([])
  })
})

describe('guardedSender: what object operations, revocation and detect get', () => {
  it('bound: a revocation goes only to revoke, a refresh token only to token, nothing credentialed to metadata', async () => {
    const r = recording()
    const send = guardedSender({ destinations: () => D, upstream: async () => r.base, resolvePublic: async () => true, bound: true })
    expect((await send({ purpose: 'revoke', url: D.revoke!, cls: 'revocation', method: 'POST', body: 'token=x' })).ok).toBe(true)
    expect((await send({ purpose: 'token', url: D.token!, cls: 'refresh_token', method: 'POST', body: 'x' })).ok).toBe(true)
    expect(await send({ purpose: 'metadata', url: D.metadata[0]!, cls: 'key', method: 'GET' })).toEqual({ ok: false, refusal: 'class' })
    expect(await send({ purpose: 'revoke', url: D.token!, cls: 'revocation', method: 'POST' })).toEqual({ ok: false, refusal: 'not_listed' })
    expect(r.sent.map(q => q.url)).toEqual([D.revoke, D.token])
  })

  it('bound with no binding (the record gone): every request refused', async () => {
    const r = recording()
    const send = guardedSender({ destinations: () => null, upstream: async () => r.base, resolvePublic: async () => true, bound: true })
    expect(await send({ purpose: 'mcp', url: D.mcp, cls: 'none', method: 'GET' })).toEqual({ ok: false, refusal: 'not_listed' })
    expect(r.sent).toEqual([])
  })

  it('unbound (detect): no credential, a public https address only', async () => {
    const r = recording()
    const send = guardedSender({ destinations: () => null, upstream: async () => r.base, resolvePublic: async () => true, bound: false })
    expect((await send({ purpose: 'mcp', url: 'https://any.example.org/mcp', cls: 'none', method: 'POST', body: '{}' })).ok).toBe(true)
    expect(await send({ purpose: 'mcp', url: 'https://any.example.org/mcp', cls: 'key', method: 'POST' })).toEqual({ ok: false, refusal: 'class' })
    expect(await send({ purpose: 'mcp', url: 'https://10.0.0.7/mcp', cls: 'none', method: 'GET' })).toEqual({ ok: false, refusal: 'address' })
    expect(await send({ purpose: 'mcp', url: 'http://any.example.org/mcp', cls: 'none', method: 'GET' })).toEqual({ ok: false, refusal: 'not_https' })
    expect(r.sent.length).toBe(1)
  })
})
