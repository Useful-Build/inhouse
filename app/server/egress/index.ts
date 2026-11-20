// The egress (`egress.internal`, p3-design 8.1): the container's one way out, per call. Every call: the host, the route
// (`model|mcp|store|files|events|audit`, else 404), the run token hashed and checked by the BrandAgent (refused: 401,
// or 410 for a closed `events` route), the token header never forwarded, ids only from the grant, request and response
// headers by allowlist, no redirects followed, pinned upstreams, logs without tokens, hashes, keys or bodies.
import { WorkerEntrypoint } from 'cloudflare:workers'
import { EGRESS_ROUTES, hashRunToken } from '../do/brand-agent/tokens.ts'
import type { EgressRoute } from '../do/brand-agent/tokens.ts'
import type { SettingsView } from '../model/catalog.ts'
import { auditRoute } from './audit.ts'
import type { EgressDeps, EgressRpc, McpHandler } from './deps.ts'
import { eventsRoute } from './events.ts'
import { gatewayUpstream, scriptedUpstream } from './gateway.ts'
import type { AiGatewayBinding } from './gateway.ts'
import { jsonAnswer, messagesError, RUN_TOKEN_HEADER } from './http.ts'
import { modelRoute } from './model.ts'
import { storeRoute } from './store.ts'

/** The test build's compile-time switch (vite.config.ts); false in every other build. */
declare const __INHOUSE_TEST_BUILD__: boolean

export const EGRESS_HOST = 'egress.internal'

/** The Runner's intercept props (p3-design 7): never a token, chat or member. */
export interface EgressProps {
  runner: string
  containerGen: number
}

const refusal = (route: EgressRoute, status: number) =>
  route === 'model' ? messagesError(status, status === 410 ? 'permission_error' : 'authentication_error', 'The run token was refused.') : jsonAnswer({ error: 'refused' }, status)

/** The request without the run token header (what a handler further in, the MCP server, sees). */
function withoutToken(request: Request): Request {
  const headers = new Headers(request.headers)
  headers.delete(RUN_TOKEN_HEADER)
  return new Request(request, { headers })
}

export async function handleEgress(request: Request, d: EgressDeps): Promise<Response> {
  const url = new URL(request.url)
  if (url.hostname !== EGRESS_HOST) return jsonAnswer({ error: 'not_found' }, 404)
  const name = /^\/([a-z]+)\//.exec(url.pathname)?.[1]
  if (!name || !(EGRESS_ROUTES as readonly string[]).includes(name)) return jsonAnswer({ error: 'not_found' }, 404)
  const route = name as EgressRoute

  const token = request.headers.get(RUN_TOKEN_HEADER)
  const checked = token ? await d.rpc.checkRunToken(await hashRunToken(token), route) : { refused: 'unknown' as const }
  if ('refused' in checked) {
    d.log({ event: 'egress_refused', route, why: checked.refused, runner: d.runner })
    return refusal(route, route === 'events' && checked.refused === 'closed' ? 410 : 401)
  }
  const grant = checked
  const path = url.pathname
  switch (route) {
    case 'model':
      return modelRoute(request, path, grant, d)
    case 'store':
      return storeRoute(request, path, grant, d)
    case 'events':
      return eventsRoute(request, path, grant, d)
    case 'audit':
      return auditRoute(request, path, grant, d)
    case 'mcp':
      if (request.method !== 'POST') return jsonAnswer({ error: 'method' }, 405)
      return d.mcp(withoutToken(request), { memberId: grant.memberId, chatId: grant.chatId, runId: grant.runId, turnId: grant.turnId })
    case 'files':
      // PR 2 (feat/chat-w3-files) serves the chat's files with its table (0120).
      return jsonAnswer({ error: 'not_built' }, 503)
  }
}

/** W6's `handleMcp` replaces this (`app/server/mcp/server.ts`); until then the MCP route answers 503. */
const mcpNotBuilt: McpHandler = async () => jsonAnswer({ error: 'not_built' }, 503)

/** The brand's technical settings the egress reads (`tm:*` for the model gate). */
export async function brandSettings(db: D1Database): Promise<SettingsView> {
  const rows = await db.prepare("SELECT key, value_json FROM settings WHERE owner = 'brand' AND key LIKE 'tm:%'").all<{ key: string; value_json: string }>()
  const out: Record<string, string | boolean | null> = {}
  for (const r of rows.results) out[r.key] = JSON.parse(r.value_json) as string | boolean | null
  return out
}

/** The env the egress reads beyond the generated `Env`: the AI binding exists only on the product deploy config. */
type EgressEnv = Env & { AI?: AiGatewayBinding; INHOUSE_TEST_BUILD?: string }

/** The real deps from the Worker's env (the test build's model is the scripted one, and only there). */
export function egressDeps(env: EgressEnv, ctx: ExecutionContext, props: EgressProps): EgressDeps {
  const testBuild = __INHOUSE_TEST_BUILD__ && env.INHOUSE_TEST_BUILD === '1'
  return {
    // W1's BrandAgent implements BrandAgentRpc (and `noteCountTokens`); the stub is typed by that interface.
    rpc: env.BRAND_AGENT.getByName('brand') as unknown as EgressRpc,
    runner: props.runner,
    touchRunner: async runner => {
      await (env.RUNNER.getByName(runner) as unknown as { touch(): Promise<void> }).touch()
    },
    upstream: testBuild ? scriptedUpstream() : gatewayUpstream(env),
    settings: () => brandSettings(env.DB),
    bucket: env.FILES,
    db: env.DB,
    mcp: mcpNotBuilt,
    waitUntil: p => ctx.waitUntil(p),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: t => clearInterval(t),
    newCallId: () => `c_${crypto.randomUUID()}`,
    now: () => Date.now(),
    log: entry => console.log(entry),
  }
}

export class Egress extends WorkerEntrypoint<Env, EgressProps> {
  async fetch(request: Request): Promise<Response> {
    return handleEgress(request, egressDeps(this.env, this.ctx, this.ctx.props))
  }
}
