// The egress (`egress.internal`, p3-design 8.1): the container's one way out, per call. Every call: the host, the route
// (`model|mcp|store|files|events|audit`, plus P4 H1's `hub` checked on the `mcp` grant, else 404), the run token hashed
// and checked by the BrandAgent (refused: 401, or 410 for a closed `events` route), the token header never forwarded,
// ids only from the grant, request and response headers by allowlist, no redirects followed, pinned upstreams, logs
// without tokens, hashes, keys or bodies.
import { WorkerEntrypoint } from 'cloudflare:workers'
import { EGRESS_ROUTES, hashRunToken } from '../do/brand-agent/tokens.ts'
import type { EgressRoute } from '../do/brand-agent/tokens.ts'
import { newFileId } from '../files-io/bytes.ts'
import { fileStore } from '../files-io/store.ts'
import type { SettingsView } from '../model/catalog.ts'
import { auditRoute } from './audit.ts'
import type { EgressDeps, EgressRpc } from './deps.ts'
import { eventsRoute } from './events.ts'
import { filesRoute } from './files.ts'
import { gatewayUpstream, scriptedUpstream } from './gateway.ts'
import { handleHub, hubRouteDeps, type ReadGatewayLike } from './hub.ts'
import { withTestShop } from '@test-shop'
import { jsonAnswer, messagesError, RUN_TOKEN_HEADER } from './http.ts'
import { mcpHandler } from '../mcp/server/index.ts'
import { notifyDeps } from '../mcp/tools/notifications/deps.ts'
import { modelRoute } from './model.ts'
import { storeRoute } from './store.ts'

/** The test issuer's compile-time switch (vite.config.ts); true in the test and eval builds only. */
declare const __INHOUSE_TEST_BUILD__: boolean
/** The eval build's compile-time switch (vite.config.ts); true there only. */
declare const __INHOUSE_EVAL_BUILD__: boolean

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
  // `/hub/` (P4 H1): the hub's read tools, the turn's second MCP server, on the grant's `mcp` route (it closes with `mcp`).
  const hub = name === 'hub' ? d.hub : undefined
  if (!name || !(hub !== undefined || (EGRESS_ROUTES as readonly string[]).includes(name))) return jsonAnswer({ error: 'not_found' }, 404)
  const route = (hub !== undefined ? 'mcp' : name) as EgressRoute

  const token = request.headers.get(RUN_TOKEN_HEADER)
  const checked = token ? await d.rpc.checkRunToken(await hashRunToken(token), route) : { refused: 'unknown' as const }
  if ('refused' in checked) {
    // `path: 'hub'` tells a refused `/hub/` call from a refused `/mcp/` one (both check the `mcp` route).
    d.log({ event: 'egress_refused', route, ...(hub !== undefined ? { path: 'hub' } : {}), why: checked.refused, runner: d.runner })
    return refusal(route, route === 'events' && checked.refused === 'closed' ? 410 : 401)
  }
  const grant = checked
  if (hub !== undefined) return handleHub(withoutToken(request), grant, hub)
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
      return filesRoute(request, path, grant, d)
  }
}

/** The brand's technical settings the egress reads (`tm:*` for the model gate). */
export async function brandSettings(db: D1Database): Promise<SettingsView> {
  const rows = await db.prepare("SELECT key, value_json FROM settings WHERE owner = 'brand' AND key LIKE 'tm:%'").all<{ key: string; value_json: string }>()
  const out: Record<string, string | boolean | null> = {}
  for (const r of rows.results) out[r.key] = JSON.parse(r.value_json) as string | boolean | null
  return out
}

/** The env the egress reads beyond the generated `Env`: the test build's flag, set only on the test build's config. */
type EgressEnv = Env & { INHOUSE_TEST_BUILD?: string }

/**
 * Whether the model route answers from the scripted model: the test build only (compiled in AND switched on, as the test
 * issuer is). The eval build compiles the test issuer in too but never the scripted model, so it always takes the gateway
 * (p3-eval-observability rev 2, rec 1). `compiled` is a seam for the unit tests (vitest defines both flags false).
 */
export function usesScriptedModel(env: Pick<EgressEnv, 'INHOUSE_TEST_BUILD'>, compiled = { test: __INHOUSE_TEST_BUILD__, eval: __INHOUSE_EVAL_BUILD__ }): boolean {
  return compiled.test && !compiled.eval && env.INHOUSE_TEST_BUILD === '1'
}

/** The real deps from the Worker's env (the test build's model is the scripted one, and only there). */
export function egressDeps(env: EgressEnv, ctx: ExecutionContext, props: EgressProps): EgressDeps {
  return {
    // W1's BrandAgent implements BrandAgentRpc; the stub is typed by that interface.
    rpc: env.BRAND_AGENT.getByName('brand') as unknown as EgressRpc,
    runner: props.runner,
    touchRunner: async runner => {
      await (env.RUNNER.getByName(runner) as unknown as { touch(): Promise<void> }).touch()
    },
    upstream: usesScriptedModel(env) ? scriptedUpstream() : gatewayUpstream(env),
    settings: () => brandSettings(env.DB),
    bucket: env.FILES,
    db: env.DB,
    files: fileStore({ db: env.DB, bucket: env.FILES }),
    newFileId,
    // W6's `inhouse` MCP server (server/mcp/server/index.ts), acting as the grant's member only.
    // P5 W4: notification_send's hub delivery, opaque to the egress (the one allowed import from the notifications tool).
    mcp: mcpHandler({ db: env.DB, notify: notifyDeps(env) }),
    // The hub's ReadGateway (P4 H1, OC 4: the only hub entrypoint the product Worker binds). In the test and eval builds
    // only, each read carries the test shop override the eval harness set (`@test-shop`; the off module returns the hub as is).
    hub: hubRouteDeps(withTestShop(env.HUB as unknown as ReadGatewayLike, env.DB, env), entry => console.log(entry)),
    waitUntil: p => ctx.waitUntil(p),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: t => clearInterval(t),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: t => clearTimeout(t),
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
