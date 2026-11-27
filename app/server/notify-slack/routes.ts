// Routes F, G and H (p5-w4.md section 10): the Slack channels the brand's admin lists for notices. Members read the
// list (F); Admins and the Inhouse team (decision 19) pick from Slack's public channels (G, through the hub's
// DeliveryGateway `HUB_DELIVERY`) and save the list (H). The matrix refuses first; each handler checks again. Every
// added or kept channel is re-checked at Slack on save, its name re-read, and a shared, archived, private or
// non-member channel refused with its reason. No notice text anywhere here.
import type { ConnectGateway, DeliveryGateway } from '../../hub/index/contract.ts'
import { hubAccountFacts } from '../do/brand-agent/hub-accounts.ts'
import { AvailableChannelsQuerySchema, PutNotifyChannelsSchema } from '../../shared/contract/notify-slack.ts'
import type { AvailableChannels } from '../../shared/contract/notify-slack.ts'
import { apiError, apiJson } from '../http.ts'
import { readBody, readQuery, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import type { HandlerEnv } from '../routes.ts'

/** The DeliveryGateway methods these routes call. */
export type ChannelsBinding = Pick<DeliveryGateway, 'listChannels' | 'checkChannel'>
export type NotifyRouteCtx = ApiCtx & { env: Pick<HandlerEnv, 'HUB_DELIVERY'> & Partial<Pick<HandlerEnv, 'HUB_CONNECT'>> }

/** Typed from the hub's plain contract (`wrangler types` gives a bare `Service`); every answer is a HubResult. */
const gateway = (c: NotifyRouteCtx): ChannelsBinding => c.env.HUB_DELIVERY as unknown as ChannelsBinding
const scope = (c: ApiCtx) => ({ kind: 'server' as const, job: 'notify-channels', requestId: c.requestId })
const SLACK = 'slack:workspace' as const

const canEdit = (c: ApiCtx) => c.principal.kind === 'inhouse' || (c.principal.kind === 'person' && c.principal.role === 'admin')

/** A hub error on these routes: Slack not usable (paused, needs a reconnect, not connected) or unreachable. */
function hubError(code: string): Response {
  if (['paused', 'scope_mismatch', 'not_configured', 'credentials_rejected', 'key_unavailable'].includes(code)) return apiError('unavailable', { reason: 'slack_not_connected' })
  if (code === 'rate_limited') return apiError('rate_limited')
  return apiError('unavailable')
}

/** Route F, `GET /api/notify/channels`: the list with its rev and the alerts mark. */
export async function listNotifyChannels(c: ApiCtx): Promise<Response> {
  return apiJson(await storesOf(c).notify.list())
}

/** Route G, `GET /api/notify/channels/available`: one page of Slack's public, unarchived channels. */
export async function availableNotifyChannels(c: NotifyRouteCtx): Promise<Response> {
  if (!canEdit(c)) return apiError('forbidden')
  const q = readQuery(c.request, AvailableChannelsQuerySchema)
  if ('error' in q) return q.error
  let r: Awaited<ReturnType<ChannelsBinding['listChannels']>>
  try {
    r = await gateway(c).listChannels(scope(c), { accountId: SLACK, ...(q.ok.cursor ? { cursor: q.ok.cursor } : {}) })
  } catch {
    return apiError('unavailable')
  }
  if (!r.ok) return hubError(r.error.code)
  const body: AvailableChannels = {
    channels: r.value.channels
      .filter(ch => !ch.archived && !ch.private && /^C[A-Z0-9]{8,}$/.test(ch.id))
      .map(ch => ({ channelId: ch.id, name: ch.name, ...(ch.shared ? { disabled: 'shared_channel' as const } : !ch.isMember ? { disabled: 'not_member' as const } : {}) })),
    nextCursor: r.value.nextCursor,
  }
  return apiJson(body)
}

/**
 * Route H, `PUT /api/notify/channels`: `{ channelIds, alertsChannelId?, ifRev }`. Each ADDED channel is checked at Slack
 * and its name read (kept ones keep theirs: every post re-checks the channel); a refused channel answers `conflict` with its reason and the channel id; a lowercase name two
 * channels would share answers `conflict` `name_taken`; a stale `ifRev` answers `conflict` with the current list (no reason).
 */
export async function putNotifyChannels(c: NotifyRouteCtx): Promise<Response> {
  if (!canEdit(c)) return apiError('forbidden')
  const body = await readBody(c.request, PutNotifyChannelsSchema)
  if ('error' in body) return body.error
  const store = storesOf(c).notify
  const current = await store.list()
  if (current.rev !== body.ok.ifRev) return apiError('conflict', { current })
  const ids = [...new Set(body.ok.channelIds)]
  // An ADDED channel must pass Slack's check here. A kept one is asked too, best effort, only for a fresh name (B2,
  // review rounds 1 and 2): any hub error keeps the stored name and still saves, and its refusal flags are ignored
  // (every post re-checks the channel), so removing a channel or moving the alerts mark saves while Slack is paused.
  const listed = new Map(current.channels.map(ch => [ch.channelId, ch]))
  const checked: { channelId: string; name: string }[] = []
  for (const channelId of ids) {
    const kept = listed.get(channelId)
    if (kept) {
      let name = kept.name
      try {
        const r = await gateway(c).checkChannel(scope(c), { accountId: SLACK, channelId })
        if (r.ok) name = r.value.name
      } catch {
        // Best effort: the stored name stays.
      }
      checked.push({ channelId, name })
      continue
    }
    let r: Awaited<ReturnType<ChannelsBinding['checkChannel']>>
    try {
      r = await gateway(c).checkChannel(scope(c), { accountId: SLACK, channelId })
    } catch {
      return apiError('unavailable')
    }
    if (!r.ok) {
      if (r.error.code === 'connect_refused') return apiError('conflict', { reason: 'not_found', current: { channelId } })
      return hubError(r.error.code)
    }
    const ch = r.value
    const refused = ch.shared ? 'shared_channel' : ch.archived ? 'archived' : ch.private ? 'not_public' : !ch.isMember ? 'not_member' : null
    if (refused) return apiError('conflict', { reason: refused, current: { channelId } })
    checked.push({ channelId, name: ch.name })
  }
  const names = new Map<string, string>()
  for (const ch of checked) {
    const key = ch.name.toLowerCase()
    if (names.has(key)) return apiError('conflict', { reason: 'name_taken', current: { channelId: ch.channelId } })
    names.set(key, ch.channelId)
  }
  // Stage 1 M2-N: moving the alerts mark gives the brand's grant, which takes the Slack account's generation. The hub owns
  // the sign-in, so its connection date is copied in first (the same sync every write request runs: M2-D's
  // `hubAccountFacts`); else the grant would take the product's own clock and the first post's sync would revoke it as
  // `account_reconnected` before its first use. A hub that can't be read leaves the row as it is (logged), and the
  // grant, if any, then lapses at that sync: fail closed.
  const alertsNow = current.channels.find(ch => ch.alerts)?.channelId ?? null
  const alertsNext = body.ok.alertsChannelId ?? null
  if (alertsNext !== null && alertsNext !== alertsNow && c.env.HUB_CONNECT) {
    await hubAccountFacts({
      connect: c.env.HUB_CONNECT as unknown as Pick<ConnectGateway, 'listAccounts'>, accounts: storesOf(c).connectors,
      nowMs: c.nowMs, requestId: c.requestId, log: entry => console.log(entry),
    })
  }
  const saved = await store.save({ channels: checked, alertsChannelId: body.ok.alertsChannelId ?? null, ifRev: body.ok.ifRev }, writer(c))
  if ('conflict' in saved) return apiError('conflict', { current: saved.conflict })
  return apiJson(saved.ok)
}
