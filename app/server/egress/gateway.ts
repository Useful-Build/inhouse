// Where the model route's calls go (p3-design 8.2): the house AI Gateway in every deployment, the scripted model in the
// test build only. No other upstream exists, and no worker calls the gateway (the orchestrator's live check proves it).
//
// AI Gateway, docs read 2026-11-20:
// - Workers binding (/ai-gateway/integrations/worker-binding-methods/): `env.AI.gateway(id).getUrl(provider)` "Returns
//   the base URL for your AI Gateway ... the provider-specific endpoint", e.g. `.../v1/<account>/<gateway>/anthropic`.
// - Anthropic provider (/ai-gateway/usage/providers/anthropic/): append `/v1/messages`; with stored keys (BYOK) "Omit
//   `x-api-key` and send only `cf-aig-authorization` with your gateway token"; "Require provider credentials" (a gateway
//   setting, no header) refuses a request with no stored key (error 2044) instead of falling back to Unified Billing.
// - Authentication (/ai-gateway/configuration/authentication/): provider-native endpoints take `cf-aig-authorization`;
//   its value is `Bearer <token>` (the Anthropic provider page's example).
// - Logging (/ai-gateway/observability/logging/): `cf-aig-collect-log-payload: false`, "Payload storage is skipped.
//   Metadata-only log entries are still saved."
// - Caching (/ai-gateway/features/caching/): `cf-aig-skip-cache: true`.
// - Request handling (/ai-gateway/configuration/request-handling/): `cf-aig-max-attempts` sets the attempts (1: no retry).
import { SYSTEM_ROUTINE_PROMPTS } from '../routines/prompts.ts'
import { createScriptedModel, routesFor, SCENARIOS } from '@scripted-model'
import type { MessagesRequest, ScenarioRoute, ScriptedModel } from '@scripted-model'

export type ModelPath = '/v1/messages' | '/v1/messages/count_tokens'

/** One call upstream. `headers` are the forwarded Messages API headers; credentials are added here only. */
export type ModelUpstream = (path: ModelPath, init: { body: string; headers: Headers; signal: AbortSignal }) => Promise<Response>

/** The Workers AI binding's gateway method, as much of it as the egress uses. */
export interface AiGatewayBinding {
  gateway(id: string): { getUrl(provider: string): Promise<string> }
}

/** The gateway request for one call (pure, so its exact shape is tested): no `x-api-key`, no run token. */
export function gatewayRequest(baseUrl: string, path: ModelPath, init: { body: string; headers: Headers; signal: AbortSignal }, gatewayToken: string): Request {
  const headers = new Headers(init.headers)
  headers.delete('x-api-key')
  headers.delete('authorization')
  headers.set('cf-aig-authorization', `Bearer ${gatewayToken}`)
  headers.set('cf-aig-collect-log-payload', 'false')
  headers.set('cf-aig-skip-cache', 'true')
  headers.set('cf-aig-max-attempts', '1')
  return new Request(`${baseUrl.replace(/\/+$/, '')}${path}`, { method: 'POST', headers, body: init.body, signal: init.signal, redirect: 'manual' })
}

/**
 * A failure known to come before the request was sent (the gateway not configured, its URL not found). The model route
 * books such a call at zero; any other rejection may have reached the model, so it's booked at its worst case.
 */
export class PreSendError extends Error {
  override name = 'PreSendError'
}

/** The house gateway. Fails loudly when the deployment lacks its id or token. */
export function gatewayUpstream(env: { AI?: AiGatewayBinding; AI_GATEWAY_ID?: string; AI_GATEWAY_TOKEN?: string }, fetcher: typeof fetch = fetch): ModelUpstream {
  return async (path, init) => {
    if (!env.AI || !env.AI_GATEWAY_ID || !env.AI_GATEWAY_TOKEN) throw new PreSendError('the AI Gateway is not configured (AI binding, AI_GATEWAY_ID, AI_GATEWAY_TOKEN)')
    let base: string
    try {
      base = await env.AI.gateway(env.AI_GATEWAY_ID).getUrl('anthropic')
    } catch (e) {
      throw new PreSendError(`the AI Gateway URL lookup failed: ${e instanceof Error ? e.name : 'unknown'}`)
    }
    return fetcher(gatewayRequest(base, path, init, env.AI_GATEWAY_TOKEN))
  }
}

/**
 * The default scenario, and the marker a test names its own with in a user message (`scenario:<name>`). The newest user
 * message that carries one wins, so a resumed session's new prompt plays its own scenario, not the first prompt's.
 */
export const DEFAULT_SCENARIO = 'hello'
/** The test build's routes for turns with no marker (none in any other build: `routesFor` is the off switch's empty one). */
const TEST_ROUTES: readonly ScenarioRoute[] = routesFor(SYSTEM_ROUTINE_PROMPTS)
const SCENARIO_MARKER = /\bscenario:([A-Za-z0-9_-]{1,64})\b/

/**
 * A user message's text: its string content, or its text blocks joined; empty when it carries a tool result (a tool's output is
 * never a prompt: it may quote a marker or a route's text).
 */
const promptTextOf = (m: MessagesRequest['messages'][number]): string => {
  if (m.role !== 'user') return ''
  if (typeof m.content === 'string') return m.content
  if (!Array.isArray(m.content)) return ''
  const blocks = m.content as { type?: unknown; text?: unknown }[]
  if (blocks.some(b => b?.type === 'tool_result')) return ''
  return blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
}
const markerOf = (m: MessagesRequest['messages'][number]): string | undefined => SCENARIO_MARKER.exec(promptTextOf(m))?.[1]

/**
 * The scenario a request plays and where its conversation starts: the newest user message with a marker (`from`, its
 * index), else (test build routes, P4 W6) the scenario of the first route whose text the first user message contains, from the
 * start, else the default from the start. A route is read from the first user message only (a system routine's turn is its own
 * chat, so its prompt is that message; test build only). A marker always wins over a route. A tool result carries no marker, so a tool loop
 * keeps its prompt's scenario.
 */
export function scenarioStart(request: MessagesRequest, routes: readonly ScenarioRoute[] = TEST_ROUTES): { scenario: string; from: number } {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const scenario = markerOf(request.messages[i]!)
    if (scenario !== undefined) return { scenario, from: i }
  }
  const first = promptTextOf(request.messages.find(m => m.role === 'user') ?? { role: 'user', content: '' })
  const route = routes.find(r => r.contains !== '' && first.includes(r.contains))
  return { scenario: route?.scenario ?? DEFAULT_SCENARIO, from: 0 }
}

/** The scenario a request plays (`scenarioStart`'s). */
export const scenarioOf = (request: MessagesRequest): string => scenarioStart(request).scenario

let scripted: ScriptedModel | undefined

/**
 * The scripted model (test build only; `@scripted-model` is the off switch in every other build). It answers
 * `/v1/messages`; it has no `count_tokens`, so a count gets a 400 and the gate keeps its byte bound (8.2).
 */
export function scriptedUpstream(): ModelUpstream {
  scripted ??= createScriptedModel(SCENARIOS)
  const model = scripted
  return async (path, init) => {
    if (path !== '/v1/messages') {
      return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'the scripted model does not count tokens' } }, { status: 400 })
    }
    let scenario = DEFAULT_SCENARIO
    let body = init.body
    try {
      const request = JSON.parse(init.body) as MessagesRequest
      const at = scenarioStart(request)
      scenario = at.scenario
      // A resumed session's prompt: its turns count from that prompt, not from the session's first one.
      // W0-B spike only (draft PR, never merged): the crash-resume scenario also reads the history before its marker.
      if (at.from > 0) body = JSON.stringify({ ...request, messages: request.messages.slice(at.from), ...(scenario === 'long-job-resume' ? { spikeEarlier: request.messages.slice(0, at.from) } : {}) })
    } catch {
      // The scripted model reports the unreadable body itself.
    }
    return model.handle(new Request(`https://scripted.invalid${path}`, { method: 'POST', headers: init.headers, body, signal: init.signal }), scenario)
  }
}
