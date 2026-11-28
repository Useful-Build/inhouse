// M4-F's fixtures in the hub's test seam (app/hub/testing/index.ts): every fixture host reaches them, the login server
// fetches an ID document through the seam, and nothing under the fixture folders imports an npm package (the hub's
// CI job installs only app/hub/node_modules, and esbuild resolves a bare import from the importing file upward, so a
// bare import there would break the test bundle; index.ts's rule).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { clientDocument, FIXTURE_REDIRECT_URIS, pkcePair } from '../../../test/upstreams/mcp/as'
import { MCP_FIXTURE_HOSTS, MCP_FIXTURES_CANARY } from '../../../test/upstreams/mcp/index'
import { modernRequest } from '../../../test/upstreams/mcp/modern'
import { mcpFixtures, testUpstreamFetch, testUpstreams } from '../index'

const BRAND = 'brand.example.com'
afterEach(() => {
  testUpstreams.delete(BRAND)
  mcpFixtures.reset()
})

describe('the seam', () => {
  it('the canary is the exact value scripts/check-hub-build.mjs reads', () => {
    expect(MCP_FIXTURES_CANARY).toBe('INHOUSE_MCP_FIXTURES_CANARY_61a9')
  })

  it('every fixture host is registered and reaches the fixtures', async () => {
    for (const host of MCP_FIXTURE_HOSTS) expect(testUpstreams.get(host), host).toBe(mcpFixtures.fetch)
    const res = await testUpstreamFetch(modernRequest('https://modern.mcp-fixtures.example.com/open/mcp', 1, 'server/discover'))
    expect(res.status).toBe(200)
    expect(mcpFixtures.log.entries.map(e => e.rpc)).toEqual(['server/discover'])
  })

  it('the login server fetches a Client ID Metadata Document through the seam (a test serves one by registering its host)', async () => {
    const url = `https://${BRAND}/oauth/client.json`
    const { challenge } = await pkcePair('seam')
    const authorize = () => testUpstreamFetch(new Request(`https://login.mcp-fixtures.example.com/std/authorize?${new URLSearchParams({ response_type: 'code', client_id: url, redirect_uri: FIXTURE_REDIRECT_URIS[1], code_challenge: challenge, code_challenge_method: 'S256' })}`))
    // Unregistered: the seam's 599 is a failed fetch, a refused path.
    expect((await authorize()).status).toBe(400)
    testUpstreams.set(BRAND, async req => (new URL(req.url).pathname === '/oauth/client.json' ? Response.json(clientDocument(url)) : new Response('no', { status: 404 })))
    expect((await authorize()).status).toBe(302)
    expect(mcpFixtures.as.clientDocFetches.map(f => f.outcome)).toEqual(['fetch_failed', 'ok'])
  })
})

describe('no npm import in the fixture folders', () => {
  const root = fileURLToPath(new URL('../../../test/upstreams/', import.meta.url).href)
  const files = ['mcp', 'rest'].flatMap(dir => readdirSync(join(root, dir)).filter(f => f.endsWith('.ts')).map(f => join(root, dir, f)))

  it('finds the files it scans (the control)', () => {
    expect(files.map(f => f.slice(root.length)).sort()).toEqual(['mcp/as.ts', 'mcp/detect.ts', 'mcp/helpdesk.ts', 'mcp/index.ts', 'mcp/legacy.ts', 'mcp/modern.ts', 'mcp/server.ts', 'mcp/vectors.ts', 'mcp/wire.ts', 'rest/server.ts'])
  })

  it('every import and export-from is relative', () => {
    for (const f of files) {
      const specs = [...readFileSync(f, 'utf8').matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]!)
      const dynamic = [...readFileSync(f, 'utf8').matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]!)
      for (const s of [...specs, ...dynamic]) expect(s.startsWith('./') || s.startsWith('../'), `${f}: ${s}`).toBe(true)
    }
  })
})
