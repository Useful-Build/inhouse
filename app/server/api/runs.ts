// Turns, runs and traces (P3, p3-design sections 3, 4.3 and 4.9): routes 29 to 33. Owner: W1 (p3-w1.md).
//
// Route 29 resolves the turn first (4.9): the owner check (another person's chat is 404 before `requireObject`, a
// deleted one too), the model from the picker's id and the brand's technical settings (unknown → 400, off or unpriced →
// 403 `model_off`), the effort, the side model, `maxTurns` and WebFetch's hosts; then the BrandAgent admits it (4.3)
// and answers at once, never waiting for placement. Attachments are checked by the BrandAgent against the stored input
// rows (`files.inputsOf`), never taken from the client's names.
import { ChatIdSchema } from '../../shared/contract/chat-ids.ts'
import { RunIdSchema } from '../../shared/contract/chat-ids.ts'
import { SendTurnInputSchema, TurnIdSchema } from '../../shared/contract/runs.ts'
import { MAX_TURNS, parseHostlist } from '../../shared/contract/settings-table.ts'
import { apiError, apiJson } from '../http.ts'
import { readCapped, storesOf } from '../db/handler-kit.ts'
import { BRAND_OWNER } from '../db/settings.ts'
import { CATALOG, resolveModel } from '../model/catalog.ts'
import type { CatalogModel, SettingsView } from '../model/catalog.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import type { Actor, RunScope } from '../do/brand-agent/ports.ts'
import type { Principal } from '../auth/index.ts'
import type { Handler, HandlerContext } from '../routes.ts'

/** Route 29's body cap (p3-design section 3). */
export const SEND_BODY_MAX_BYTES = 1024 * 1024

/** The member a turn route acts for: a person or the smoke member (the matrix lets no one else through). */
export function actorOf(p: Principal): Actor | null {
  if (p.kind === 'person') return { kind: 'person', memberId: p.memberId }
  if (p.kind === 'service' && p.name === 'smoke') return { kind: 'service', memberId: p.memberId }
  return null
}

async function readJson(request: Request, max: number): Promise<unknown> {
  const bytes = await readCapped(request, max)
  if (bytes === null) return undefined
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
}

const refused = (r: { refused: { code: Parameters<typeof apiError>[0]; reason?: string } }) =>
  apiError(r.refused.code, r.refused.reason === undefined ? {} : { reason: r.refused.reason })

/** Route 29 over a given catalogue (tests pass a priced copy; the route uses the shipped one). */
export function sendTurnWith(catalog: readonly CatalogModel[]): Handler {
  return async (c: HandlerContext) => {
    const by = actorOf(c.principal)
    if (!by) return apiError('forbidden')
    const chatId = ChatIdSchema.safeParse(c.params.id)
    if (!chatId.success) return apiError('not_found')
    const body = SendTurnInputSchema.safeParse(await readJson(c.request, SEND_BODY_MAX_BYTES))
    if (!body.success) return apiError('invalid')
    const stores = storesOf(c)
    // Prefilter: another person's chat (or a deleted one, or none) is 404, before the object check.
    const chat = await stores.chats.ownerOf(chatId.data)
    if (!chat || chat.ownerId !== by.memberId || chat.deleted) return apiError('not_found')
    c.access.requireObject({ ownerId: chat.ownerId })
    const settings: Record<string, string | boolean | null> = {}
    for (const s of await stores.settings.list(BRAND_OWNER, 'technical')) settings[s.key] = s.value as string | boolean | null
    const resolved = resolveModel(body.data.model, settings as SettingsView, catalog)
    if ('refused' in resolved) return refused(resolved)
    const maxTurnsSetting = settings['t:max_turns']
    const maxTurns = typeof maxTurnsSetting === 'string' && (MAX_TURNS as readonly string[]).includes(maxTurnsSetting) ? Number(maxTurnsSetting) : 25
    // An empty `t:webfetch` (the default) is any public host; a list narrows it; a stored value that breaks the rule
    // allows no host (fail closed).
    const hostSetting = settings['t:webfetch']
    const hosts = typeof hostSetting === 'string' ? parseHostlist(hostSetting) : []
    const webFetchDomains = hosts === null ? [] : hosts.length === 0 ? null : hosts
    const answer = await brandAgent(c.env).submitTurn({
      chatId: chatId.data, input: body.data, by, model: resolved.model.apiId, pickerId: resolved.model.id, effort: resolved.effort,
      sideModel: resolved.sideApiId, maxTurns, webFetchDomains,
    })
    return 'refused' in answer ? refused(answer) : apiJson(answer)
  }
}

/** Route 29, `POST /api/chats/:id/turns` (body cap 1 MiB). */
export const sendTurn: Handler = sendTurnWith(CATALOG)

/** Routes 30 and 31: another person's turn is 404 before the object check; then the BrandAgent acts on it. */
function turnAction(act: 'interrupt' | 'stop'): Handler {
  return async (c: HandlerContext) => {
    const by = actorOf(c.principal)
    if (!by) return apiError('forbidden')
    const turnId = TurnIdSchema.safeParse(c.params.turnId)
    if (!turnId.success) return apiError('not_found')
    const agent = brandAgent(c.env)
    const owner = await agent.turnOwner(turnId.data)
    if (owner !== by.memberId) return apiError('not_found')
    c.access.requireObject({ ownerId: owner })
    const answer = act === 'interrupt' ? await agent.interrupt(turnId.data, by) : await agent.stop(turnId.data, by)
    return 'refused' in answer ? refused(answer) : apiJson(answer)
  }
}

/** Route 30, `POST /api/turns/:turnId/interrupt`: the SDK interrupt (a queued turn is cancelled). */
export const interruptTurn: Handler = turnAction('interrupt')
/** Route 31, `POST /api/turns/:turnId/stop`: the hard stop of that turn only. */
export const stopTurn: Handler = turnAction('stop')
/**
 * Whose runs a read covers (routes 32 and 33): a person's or the smoke member's own; every chat's for Inhouse, only under
 * a live grant (the matrix already refuses Inhouse without one; refused here too, fail closed).
 */
function scopeOf(c: HandlerContext): RunScope | Response {
  const p = c.principal
  if (p.kind === 'inhouse') return p.grant && p.grant.endsAtMs > c.nowMs ? { all: true } : apiError('forbidden', { reason: 'grant_required' })
  const by = actorOf(p)
  return by ? { owner: by.memberId } : apiError('forbidden')
}

/** Route 32, `GET /api/runs/active`: `{ runs }`, the live runs and the ended ones not yet in D1, in the caller's scope. */
export const activeRuns: Handler = async (c: HandlerContext) => {
  const scope = scopeOf(c)
  if (scope instanceof Response) return scope
  const runs = await brandAgent(c.env).activeRuns(scope)
  // A list filtered by owner checks the caller's own object (section 3).
  if ('owner' in scope) c.access.requireObject({ ownerId: scope.owner })
  return apiJson({ runs })
}

/** Route 33, `GET /api/traces/:id` (a run or a turn id): another person's is 404 before the object check. */
export const getTrace: Handler = async (c: HandlerContext) => {
  const scope = scopeOf(c)
  if (scope instanceof Response) return scope
  const id = c.params.id
  if (!RunIdSchema.safeParse(id).success && !TurnIdSchema.safeParse(id).success) return apiError('not_found')
  const trace = await brandAgent(c.env).getTrace(id, scope)
  if (!trace) return apiError('not_found')
  if ('owner' in scope) c.access.requireObject({ ownerId: scope.owner })
  return apiJson(trace)
}
