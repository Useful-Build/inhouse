// The real contract target's connector part (P5 W5 section 3): what `connectTool`, `disconnectTool`, `setToolPaused` and the
// notice-channel methods need beside P2's. Two facts shape it:
//  - The Tools writes belong to the Inhouse team's app (`technical` rows, allow `inhouse`), so the target's client sends
//    those requests to the Inhouse origin signed in as the seeded Inhouse member (`isToolsWrite`, `inhouseFetch`). The
//    write still happens on the one client the cases read: its optimistic change, rollback and notices are its own. The
//    notice-channel reads and writes run as the Admin (an Admin may edit them), after the world is put in the state they need.
//  - No single Slack state fits every shared case: `connectTool` must answer an address and `disconnectTool` must be refused
//    (Slack not connected), while the channel picker needs Slack usable (connected). `prepare(method)` puts Slack in the state
//    the method's case reads, through the same routes a person uses, before the call. It changes the world, never the answer.
// Served over HTTP, no exemption: the same cases the mock passes. The orchestrator wires this into index.ts (lines in the PR
// body) and serve.ts sets `CONTRACT_REAL_INHOUSE_AUD` and `CONTRACT_REAL_INHOUSE_ORIGIN` (names only, like the brand's).
import type { JWK } from 'jose'
import { SEED_INHOUSE } from '../../../../../server/seed/brand'
import { mintPerson, mintService } from '../../../../../server/auth/test-issuer-mint'
import { mintTestCode } from '../../../../../test/upstreams/mcp/server'
import type { AgentClient } from '../../../types'
import type { WriteMethod } from '../../targets'

const env: Record<string, string | undefined> = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const need = (name: string): string => {
  const v = env[name]
  if (!v) throw new Error(`The real contract target's connector part needs ${name} in the environment: run it through e2e/support/test-build/serve.ts.`)
  return v
}

const ACCOUNT = 'slack:workspace'
const slackPath = (tail: string) => `/api/tools/${encodeURIComponent(ACCOUNT)}/${tail}`

/** The methods this part adds to the target's served set. */
export const CONNECTOR_METHODS = [
  'connectTool', 'disconnectTool', 'setToolPaused', 'listNotifyChannels', 'availableNotifyChannels', 'saveNotifyChannels',
] as const satisfies readonly (keyof AgentClient)[]

/** What the target's `fixtures.toolKey` is for the connector cases: Slack, the one OAuth tool the test build connects. */
export const CONNECTOR_TOOL_KEY = 'slack'

/** Methods whose case reads Slack as not connected, and the ones that need it usable. */
const NEEDS_DISCONNECTED: ReadonlySet<string> = new Set(['connectTool', 'disconnectTool', 'setToolPaused'])
const NEEDS_CONNECTED: ReadonlySet<string> = new Set(['availableNotifyChannels', 'saveNotifyChannels'])

/**
 * The route an armed refusal is aimed at, for the connector write methods (the target's `routeOf` falls through to this):
 * the verbs and the exact path, from the call's arguments. `setToolPaused` and the other two name Slack by its hub account id
 * (the client reads it from the tools read), which the test build's one OAuth tool fixes.
 */
export function connectorRoute(method: WriteMethod, args: unknown[]): { verbs: string[]; path: string } | null {
  switch (method) {
    case 'setToolPaused': return args[0] === CONNECTOR_TOOL_KEY ? { verbs: ['PUT'], path: slackPath('paused') } : null
    case 'disconnectTool': return args[0] === CONNECTOR_TOOL_KEY ? { verbs: ['POST'], path: slackPath('disconnect') } : null
    case 'connectTool': return args[0] === CONNECTOR_TOOL_KEY ? { verbs: ['POST'], path: `/api/connect/${encodeURIComponent(ACCOUNT)}/start` } : null
    case 'saveNotifyChannels': return { verbs: ['PUT'], path: '/api/notify/channels' }
    default: return null
  }
}

/**
 * Whether a request is one of the Tools writes, which only the Inhouse team may send: the paths `connectorRoute` aims at.
 * The target sends these from its one client with the Inhouse member's sign-in (`inhouseFetch`), so the client that
 * wrote is the one whose snapshot, listeners and notices the shared cases read.
 */
export function isToolsWrite(method: string, pathname: string): boolean {
  return (method === 'PUT' && pathname === slackPath('paused'))
    || (method === 'POST' && pathname === slackPath('disconnect'))
    || (method === 'POST' && pathname === `/api/connect/${encodeURIComponent(ACCOUNT)}/start`)
}

export interface ConnectorWorld {
  /** One request (a path and its query) to the Inhouse origin as the Inhouse member, the rest of `init` as it is. */
  inhouseFetch(pathAndQuery: string, init?: RequestInit): Promise<Response>
  /** The Slack state a method's case reads, or null for any other method. */
  needs(method: string): 'connected' | 'disconnected' | null
  /** Puts the world in the state the method's case reads (a no-op for any other method). */
  prepare(method: string): Promise<void>
  /** Back to the start: the fakes reset, no channels listed, Slack disconnected after a first connect (so its row exists). */
  reset(): Promise<void>
}

export function connectorWorld(brandOrigin: string): ConnectorWorld {
  const inhouseOrigin = need('CONTRACT_REAL_INHOUSE_ORIGIN')
  const key = JSON.parse(need('INHOUSE_TEST_ISSUER_PRIVATE_JWK')) as JWK
  const jwt = (aud: string, sub: string, email: string) => mintPerson({ key, aud, sub, email })
  const inhouseHeaders = async (): Promise<Record<string, string>> => ({
    'Cf-Access-Jwt-Assertion': await jwt(need('CONTRACT_REAL_INHOUSE_AUD'), SEED_INHOUSE.subject, SEED_INHOUSE.email),
    Origin: inhouseOrigin,
  })

  /** One request as the Inhouse member, outside the client. */
  const inhouse = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any; location: string | null }> => {
    const headers = { Accept: 'application/json', ...(await inhouseHeaders()), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }
    const res = await fetch(inhouseOrigin + path, { method, headers, redirect: 'manual', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const text = await res.text()
    let json: unknown
    try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
    return { status: res.status, json, location: res.headers.get('location') }
  }
  /** The release token's hook (the fakes): the same route the API specs use. */
  const hook = async (body: Record<string, unknown>) => {
    const headers = { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': await mintRelease(), Origin: brandOrigin }
    const res = await fetch(`${brandOrigin}/api/ops/test-fakes`, { method: 'POST', headers, body: JSON.stringify(body) })
    if (res.status !== 200) throw new Error(`The test-fakes hook refused ${String(body.op)}: ${res.status}`)
  }
  const mintRelease = (): Promise<string> => mintService({ key, aud: need('CONTRACT_REAL_BRAND_AUD'), clientId: need('CONTRACT_REAL_RELEASE_CLIENT_ID') })

  const slackState = async (): Promise<'connected' | 'disconnected' | 'never'> => {
    const r = await inhouse('GET', '/api/tools')
    if (r.status !== 200) throw new Error(`The real contract target couldn't read the tools as the Inhouse member: ${r.status}`)
    if ((r.json.connected as string[]).includes(CONNECTOR_TOOL_KEY)) return 'connected'
    return r.json.details?.[CONNECTOR_TOOL_KEY] ? 'disconnected' : 'never'
  }
  const connect = async (): Promise<void> => {
    const start = await inhouse('POST', `/api/connect/${encodeURIComponent(ACCOUNT)}/start`, {})
    if (start.status !== 200) throw new Error(`Connecting Slack in the real contract target failed at the start: ${start.status}`)
    const minted = await mintTestCode(start.json.authorizeUrl)
    const u = new URL(minted.callbackUrl)
    const done = await inhouse('GET', `${u.pathname}${u.search}`)
    if (done.location !== `/tools/${CONNECTOR_TOOL_KEY}?connected=1`) throw new Error(`Connecting Slack in the real contract target ended at ${String(done.location)}`)
  }
  const disconnect = async (): Promise<void> => {
    const r = await inhouse('POST', slackPath('disconnect'), {})
    if (r.status !== 200) throw new Error(`Disconnecting Slack in the real contract target failed: ${r.status}`)
  }
  const ensure = async (want: 'connected' | 'disconnected'): Promise<void> => {
    let now = await slackState()
    if (now === 'never') { await connect(); now = 'connected' }
    if (want === 'connected' && now === 'disconnected') await connect()
    if (want === 'disconnected' && now === 'connected') await disconnect()
  }
  const unpause = async () => { await inhouse('PUT', slackPath('paused'), { paused: false }) }

  return {
    async inhouseFetch(pathAndQuery, init = {}) {
      const headers = new Headers(init.headers)
      for (const [k, v] of Object.entries(await inhouseHeaders())) headers.set(k, v)
      return fetch(inhouseOrigin + pathAndQuery, { ...init, headers })
    },
    needs: method => (NEEDS_DISCONNECTED.has(method) ? 'disconnected' : NEEDS_CONNECTED.has(method) ? 'connected' : null),
    async prepare(method) {
      if (NEEDS_DISCONNECTED.has(method)) await ensure('disconnected')
      else if (NEEDS_CONNECTED.has(method)) { await ensure('connected'); await unpause() }
    },
    async reset() {
      await hook({ op: 'reset' })
      await ensure('connected')
      await unpause()
      // No channels listed: each case lists its own.
      const cur = await inhouse('GET', '/api/notify/channels')
      if (cur.status !== 200) throw new Error(`The real contract target couldn't read the listed channels: ${cur.status}`)
      if ((cur.json.channels as unknown[]).length > 0) {
        const cleared = await inhouse('PUT', '/api/notify/channels', { channelIds: [], ifRev: cur.json.rev })
        if (cleared.status !== 200) throw new Error(`The real contract target couldn't clear the listed channels: ${cleared.status}`)
      }
      await ensure('disconnected')
    },
  }
}
