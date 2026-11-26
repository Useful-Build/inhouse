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
import { handleHub, HUB_MAX_BODY_BYTES, hubRouteDeps, type ReadGatewayLike } from './hub.ts'
import { brandStage } from '../stage/watch.ts'
import { withTestShop } from '@test-shop'
import { jsonAnswer, messagesError, readCapped, RUN_TOKEN_HEADER } from './http.ts'
import { mcpHandler } from '../mcp/server/index.ts'
import { QUESTIONS_ON } from '../questions/switch.ts'
import { notifyDeps } from '../mcp/tools/notifications/deps.ts'
import { modelRoute } from './model.ts'
import { storeRoute } from './store.ts'
import { TaintOverflowError, taintStore, type CaptureTaint, type TaintSource } from './taint.ts'
import { safeError } from '../safe-error.ts'

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

export interface EgressOptions {
  /** Runs on `/hub/`, `/mcp/` and text-like `/files/` responses before returning; required, so no route skips it. */
  captureTaint: CaptureTaint
}

/** What the agent reads when a result holds more tokens than the leak check tracks in one read (fail closed). */
export const TAINT_OVERFLOW_TEXT =
  'Not read: the result holds more ids, emails or order numbers than one read may carry. Ask for fewer items (a smaller page or a narrower search).'

/**
 * The hub tool a `/hub/` call names (`tools/call`'s `params.name`), read from a copy of the request within the hub's
 * own body cap; null for anything else, so nothing in its answer counts as catalogue data (decision L2).
 */
async function hubToolName(copy: Request): Promise<string | null> {
  const bytes = await readCapped(copy, HUB_MAX_BODY_BYTES)
  if (bytes === null) return null
  try {
    const message: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (typeof message !== 'object' || message === null || (message as { method?: unknown }).method !== 'tools/call') return null
    const name = (message as { params?: { name?: unknown } }).params?.name
    return typeof name === 'string' ? name : null
  } catch {
    return null
  }
}

/**
 * Awaits taint capture on a 200 `/hub/` or `/mcp/` response before returning it. Fails closed on capture error so
 * uncaptured private data never reaches the container (N8). A result with too many tokens answers the call as a
 * JSON-RPC tool error with a plain reason (`TAINT_OVERFLOW_TEXT`), never the result.
 */
async function captureResponse(res: Response, d: EgressDeps, source: TaintSource, captureTaint: CaptureTaint): Promise<Response> {
  if (res.status !== 200) return res
  const text = await res.text()
  const route = source.route
  try {
    await captureTaint(text, source)
  } catch (err) {
    if (err instanceof TaintOverflowError) {
      d.log({ event: 'egress_taint_capture_refused', route, reason: 'too_many_tokens', runner: d.runner })
      return jsonAnswer({ jsonrpc: '2.0', id: rpcId(text), result: { content: [{ type: 'text', text: TAINT_OVERFLOW_TEXT }], isError: true } })
    }
    d.log({ event: 'egress_taint_capture_failed', route, error: safeError(err), runner: d.runner })
    return jsonAnswer({ error: 'internal' }, 500)
  }
  return new Response(text, { status: res.status, headers: res.headers })
}

/** The JSON-RPC id of an answer, so a refusal answers the same call (null when it can't be read). */
function rpcId(text: string): string | number | null {
  try {
    const id = (JSON.parse(text) as { id?: unknown }).id
    return typeof id === 'string' || typeof id === 'number' ? id : null
  } catch {
    return null
  }
}

/**
 * The egress's one entry. Its last catch answers a fixed 500 and logs the error's name only (P8a P-auth): an uncaught
 * throw would put its message in the runtime's own exception log. A failure inside a streamed body, after the answer
 * left, is the route's own to handle.
 */
export async function handleEgress(request: Request, d: EgressDeps, opts: EgressOptions): Promise<Response> {
  try {
    return await routeEgress(request, d, opts)
  } catch (e) {
    d.log({ event: 'egress_failed', error: safeError(e), runner: d.runner })
    return jsonAnswer({ error: 'internal' }, 500)
  }
}

async function routeEgress(request: Request, d: EgressDeps, opts: EgressOptions): Promise<Response> {
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
  if (hub !== undefined) {
    const copy = request.clone() as unknown as Request
    const res = await handleHub(withoutToken(request), grant, hub)
    if (res.status !== 200) return res
    return captureResponse(res, d, { route: 'hub', tool: await hubToolName(copy) }, opts.captureTaint)
  }
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
    case 'mcp': {
      if (request.method !== 'POST') return jsonAnswer({ error: 'method' }, 405)
      const res = await d.mcp(withoutToken(request), { memberId: grant.memberId, chatId: grant.chatId, runId: grant.runId, turnId: grant.turnId })
      return captureResponse(res, d, { route: 'mcp' }, opts.captureTaint)
    }
    case 'files':
      return filesRoute(request, path, grant, d, opts.captureTaint)
  }
}

/** The brand's settings the egress reads: the technical `tm:*` and the brand's `t:websearch` switch (an Admin's, M1-F) for the model gate. */
export async function brandSettings(db: D1Database): Promise<SettingsView> {
  const rows = await db.prepare("SELECT key, value_json FROM settings WHERE owner = 'brand' AND (key LIKE 'tm:%' OR key = 't:websearch')").all<{ key: string; value_json: string }>()
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
    // Stage 1 M2-Q: `question_ask` only where this build turns questions on (server/questions/switch.ts: the test build).
    mcp: mcpHandler({ db: env.DB, notify: notifyDeps(env), questions: QUESTIONS_ON }),
    // The hub's ReadGateway (P4 H1, OC 4: the only hub entrypoint the product Worker binds). In the test and eval builds
    // only, each read carries the test shop override the eval harness set (`@test-shop`; the off module returns the hub as is).
    hub: hubRouteDeps(withTestShop(env.HUB as unknown as ReadGatewayLike, env.DB, env), entry => console.log(entry), () => brandStage(env.DB)),
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
    const taint = taintStore(this.env.DB, this.env.AUDIT_HASH_KEY, () => Date.now())
    return handleEgress(request, egressDeps(this.env, this.ctx, this.ctx.props), { captureTaint: (body, source) => taint.capture(body, source).then(() => undefined) })
  }
}
