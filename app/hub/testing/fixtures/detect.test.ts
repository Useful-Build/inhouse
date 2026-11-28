// Detect's addresses (app/test/upstreams/mcp/detect.ts; connect plan checklist 1, N37): each of the six answers, with
// no credential, as the spec pages say for its outcome; the hostile ones redirect or point at a private address. This is
// the fixture's half: the probe below is raw requests, not M4-D's detect.
import { beforeEach, describe, expect, it } from 'vitest'
import { DETECT_ADDRESSES, DETECT_HOSTILE } from '../../../test/upstreams/mcp/detect'
import type { McpFixtures } from '../../../test/upstreams/mcp/index'
import { legacyInitialize } from '../../../test/upstreams/mcp/legacy'
import { HOSTS } from '../../../test/upstreams/mcp/wire'
import { fixtures, modern, rpcOf } from './kit'

let fx: McpFixtures
beforeEach(() => {
  fx = fixtures()
})

/** The login server's metadata for an issuer, by RFC 8414 path insertion. */
async function loginMeta(issuer: string): Promise<Record<string, unknown>> {
  const u = new URL(issuer)
  return (await (await fx.fetch(new Request(`${u.origin}/.well-known/oauth-authorization-server${u.pathname}`))).json()) as Record<string, unknown>
}

/** The resource metadata a 401's Bearer challenge names. */
async function challenged(url: string): Promise<{ resource: string; authorization_servers: string[] }> {
  const res = await modern(fx, url, 'server/discover')
  expect(res.status).toBe(401)
  const www = res.headers.get('WWW-Authenticate')!
  expect(www).toMatch(/^Bearer /)
  return (await (await fx.fetch(new Request(/resource_metadata="([^"]+)"/.exec(www)![1]!))).json()) as { resource: string; authorization_servers: string[] }
}

describe('six addresses, six outcomes (connect plan section 5 step 0)', () => {
  it('open: server/discover and tools/list answer with no credential (server/discover, server/tools)', async () => {
    expect((await rpcOf(await modern(fx, DETECT_ADDRESSES.open, 'server/discover'))).result!.supportedVersions).toEqual(['2026-07-28'])
    expect((await modern(fx, DETECT_ADDRESSES.open, 'tools/list')).status).toBe(200)
  })

  it('signin: a Bearer challenge; the metadata names this resource; its login server takes our ID document and offers registration', async () => {
    const prm = await challenged(DETECT_ADDRESSES.signin)
    expect(prm.resource).toBe(DETECT_ADDRESSES.signin)
    const doc = await loginMeta(prm.authorization_servers[0]!)
    expect(doc.issuer).toBe(prm.authorization_servers[0])
    expect(doc.client_id_metadata_document_supported).toBe(true)
    expect(doc.registration_endpoint).toEqual(expect.any(String))
  })

  it('signin_needs_app: the same, but the login server offers neither', async () => {
    const prm = await challenged(DETECT_ADDRESSES.signin_needs_app)
    expect(prm.resource).toBe(DETECT_ADDRESSES.signin_needs_app)
    const doc = await loginMeta(prm.authorization_servers[0]!)
    expect(doc.client_id_metadata_document_supported).toBeUndefined()
    expect(doc.registration_endpoint).toBeUndefined()
  })

  it('key: refused without a Bearer challenge, and no resource metadata at either well-known address', async () => {
    const res = await modern(fx, DETECT_ADDRESSES.key, 'server/discover')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).not.toMatch(/Bearer/i)
    expect((await fx.fetch(new Request(`https://${HOSTS.modern}/.well-known/oauth-protected-resource/key/mcp`))).status).toBe(404)
    expect((await fx.fetch(new Request(`https://${HOSTS.modern}/.well-known/oauth-protected-resource`))).status).toBe(404)
  })

  it('blocked: a firewall challenge page (403, HTML, cf-mitigated), not a sign-in', async () => {
    const res = await modern(fx, DETECT_ADDRESSES.blocked, 'server/discover')
    expect(res.status).toBe(403)
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/)
    expect(res.headers.get('cf-mitigated')).toBe('challenge')
    expect(res.headers.get('WWW-Authenticate')).toBeNull()
  })

  it('not_mcp: a REST API base address: 404, a plain JSON error, no challenge, for a modern and a legacy first request', async () => {
    for (const res of [await modern(fx, DETECT_ADDRESSES.not_mcp, 'server/discover'), await fx.fetch(legacyInitialize(DETECT_ADDRESSES.not_mcp))]) {
      expect(res.status).toBe(404)
      expect(res.headers.get('WWW-Authenticate')).toBeNull()
      expect(await res.json()).toEqual({ message: 'Not Found' })
    }
  })

  it('every probe above went out with no credential, and the log holds each discover line (the control)', async () => {
    for (const url of Object.values(DETECT_ADDRESSES)) await modern(fx, url, 'server/discover')
    expect(fx.log.entries.every(e => e.credential === 'none')).toBe(true)
    expect(fx.log.entries.filter(e => e.rpc === 'server/discover').map(e => `https://${e.host}${e.path}`)).toEqual(Object.values(DETECT_ADDRESSES))
  })
})

describe('the hostile addresses (N37: never follows a redirect; metadata hops are checked like any other)', () => {
  it('same-origin and cross-origin redirects answer 3xx with a Location; the fixture itself follows nothing', async () => {
    for (const { url } of [DETECT_HOSTILE.redirectSameOrigin, DETECT_HOSTILE.redirectCrossOrigin]) {
      fx.log.clear()
      const res = await modern(fx, url, 'server/discover')
      expect([307, 308]).toContain(res.status)
      expect(res.headers.get('Location')).toBe(`https://${HOSTS.modern}/open/mcp`)
      // One line: the probe. A client that followed would add a second, to /open/mcp.
      expect(fx.log.entries.map(e => [e.host, e.path, e.status])).toEqual([[new URL(url).host, new URL(url).pathname, res.status]])
    }
  })

  it("private metadata: the resource metadata names a login server at a private address; the trap logs any hop that reaches it", async () => {
    const prm = await challenged(DETECT_HOSTILE.privateMetadata.url)
    expect(prm.authorization_servers).toEqual([`https://${HOSTS.privateTrap}`])
    expect(fx.log.entries.some(e => e.host === HOSTS.privateTrap)).toBe(false)
    // Control: a request that does reach the trap is in the log.
    await fx.fetch(new Request(`https://${HOSTS.privateTrap}/.well-known/oauth-authorization-server`))
    expect(fx.log.entries.filter(e => e.host === HOSTS.privateTrap)).toHaveLength(1)
  })

  it('a 2025-11-25 server is found open by the fallback to initialize', async () => {
    expect((await modern(fx, DETECT_HOSTILE.legacyOpen.url, 'server/discover')).status).toBe(400)
    expect((await fx.fetch(legacyInitialize(DETECT_HOSTILE.legacyOpen.url))).status).toBe(200)
  })
})
