// Routes 120 to 125 (Stage 1 M2-B, N11, N15, N18; M3-B, N22 and N33: a batch's full list): the outbox's cards and a
// person's answers to them. Brand people only
// (the matrix); the rules on the object are the outbox's, in its statements: the asker sees their own cards (with the
// chat), an admin sees every card's facts (never another person's chat) and may resolve a "Needs a check"; only the
// card's approver answers, undoes or resolves it otherwise. No route makes an action: `request` is the agent's (M2-D).
import {
  ActionCardSchema, ActionFilterSchema, ActionIdSchema, ActionItemsPageSchema, ActionItemsQuerySchema, ActionsListSchema, AnswerActionInputSchema,
  ResolveActionInputSchema, UndoActionInputSchema,
} from '../../shared/contract/actions.ts'
import { ChatIdSchema } from '../../shared/contract/chat-ids.ts'
import { readBody, readQuery, storesOf } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import { apiError, apiJson } from '../http.ts'
import type { Viewer } from '../outbox/card.ts'
import { SEND_KIND, sendTaskId } from '../outbox/send-task.ts'
import type { OutboxActionRow, OutboxChange } from '../outbox/types.ts'
import { z } from 'zod'

/** The person asking. The matrix lets only brand people through; anything else is a wiring bug. */
function viewerOf(c: ApiCtx): Viewer {
  const p = c.principal
  if (p.kind !== 'person') throw new Error('actions: only a brand person reaches these routes')
  return { memberId: p.memberId, role: p.role }
}

type Ctx = ApiCtx & { env: Pick<Env, 'BRAND_AGENT'> }
const at = (c: Ctx) => ({ requestId: c.requestId, nowMs: c.nowMs })

/**
 * An approval asks BrandAgent for its send task at the hold's end. A failed ask is logged, not answered as an error: the
 * approval stands, and the sweep schedules an approved row whose task was lost (N11).
 */
async function scheduleSend(c: Ctx, change: OutboxChange): Promise<void> {
  if (!('action' in change) || change.action.state !== 'approved' || change.action.send_at_ms === null) return
  try {
    await brandAgent(c.env).poke({ kind: SEND_KIND, id: sendTaskId(change.action.id), dueAtMs: change.action.send_at_ms })
  } catch (err) {
    console.error({ event: 'outbox_schedule_failed', actionId: change.action.id, requestId: c.requestId, error: err instanceof Error ? err.name : 'unknown' })
  }
}

/**
 * Stage 1 M2-D (N14): a change reaches the chat (`action.updated`) and, once final, the agent (the report), through
 * BrandAgent's deliver task. A failed ask is logged: the asks' sweep finds the change within a minute.
 */
async function tellAgent(c: Ctx, change: OutboxChange): Promise<void> {
  if (!('action' in change)) return
  try {
    await brandAgent(c.env).actionChanged(change.action.id)
  } catch (err) {
    console.error({ event: 'action_changed_failed', actionId: change.action.id, requestId: c.requestId, error: err instanceof Error ? err.name : 'unknown' })
  }
}

const ListQuerySchema = z.object({ states: z.string().max(200).optional(), chatId: ChatIdSchema.optional() }).strict()

/** Route 120, `GET /api/actions?states=a,b&chatId=`: `{ items }`, newest first, the cards this person may see. */
export async function listActions(c: Ctx): Promise<Response> {
  const query = readQuery(c.request, ListQuerySchema)
  if ('error' in query) return query.error
  const filter = ActionFilterSchema.safeParse({
    ...(query.ok.states !== undefined ? { states: query.ok.states.split(',') } : {}),
    ...(query.ok.chatId !== undefined ? { chatId: query.ok.chatId } : {}),
  })
  if (!filter.success) return apiError('invalid')
  const viewer = viewerOf(c)
  const rows = await storesOf(c).outbox.list(viewer, filter.data)
  return apiJson(ActionsListSchema.parse({ items: await storesOf(c).outbox.cards(viewer, rows, c.nowMs) }))
}

/** Route 121, `GET /api/actions/:id`: the card, or 404 for one this person may not see. */
export async function getAction(c: Ctx): Promise<Response> {
  const id = ActionIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const viewer = viewerOf(c)
  const row = await storesOf(c).outbox.get(viewer, id.data)
  return row ? apiJson(ActionCardSchema.parse(await cardFor(c, row, viewer))) : apiError('not_found')
}

const cardFor = async (c: Ctx, row: OutboxActionRow, viewer: Viewer) => (await storesOf(c).outbox.cards(viewer, [row], c.nowMs))[0]!

/** A change's answer: the card; a stale or lost race is 409 with the current card; other refusals by their code. */
async function answerOf(c: Ctx, id: string, change: OutboxChange): Promise<Response> {
  const viewer = viewerOf(c)
  if ('action' in change) return apiJson(await cardFor(c, change.action, viewer))
  const { code, reason } = change.refused
  if (code === 'conflict') {
    const row = await storesOf(c).outbox.get(viewer, id)
    return apiError('conflict', { ...(reason ? { reason } : {}), current: row ? await cardFor(c, row, viewer) : undefined })
  }
  return apiError(code, reason ? { reason } : {})
}

/**
 * Route 122, `POST /api/actions/:id/answer` `{ choice, ifRev, upTo?, totals? }`: a batch's answer carries the items it
 * covers and their totals as the card showed them (the outbox refuses it for a single action, and refuses a batch's
 * without them, `invalid`; totals that no longer match are 409 `totals_changed`).
 */
export async function answerAction(c: Ctx): Promise<Response> {
  const id = ActionIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const body = await readBody(c.request, AnswerActionInputSchema)
  if ('error' in body) return body.error
  const change = await storesOf(c).outbox.answer(viewerOf(c), id.data, body.ok, at(c))
  await scheduleSend(c, change)
  await tellAgent(c, change)
  return answerOf(c, id.data, change)
}

/** Route 123, `POST /api/actions/:id/undo` `{ ifRev }`: an approved action, before its claim. After it: 409. */
export async function undoAction(c: Ctx): Promise<Response> {
  const id = ActionIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const body = await readBody(c.request, UndoActionInputSchema)
  if ('error' in body) return body.error
  const change = await storesOf(c).outbox.undo(viewerOf(c), id.data, body.ok, at(c))
  await tellAgent(c, change)
  return answerOf(c, id.data, change)
}

/**
 * Route 124, `POST /api/actions/:id/resolve` `{ outcome, ifRev, item? }`: "Needs a check", by its approver or an admin;
 * a batch's unclear items one at a time, by position (required for a batch, refused for a single action).
 */
export async function resolveAction(c: Ctx): Promise<Response> {
  const id = ActionIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const body = await readBody(c.request, ResolveActionInputSchema)
  if ('error' in body) return body.error
  const change = await storesOf(c).outbox.resolve(viewerOf(c), id.data, body.ok, at(c))
  await tellAgent(c, change)
  return answerOf(c, id.data, change)
}

/**
 * Route 125, `GET /api/actions/:id/items?after=n` (Stage 1 M3-B, N22, N33): a batch's full list, 100 items a page, for a
 * person who may see its card. A single action has no list (404), like a card this person may not see.
 */
export async function listActionItems(c: Ctx): Promise<Response> {
  const id = ActionIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const query = readQuery(c.request, ActionItemsQuerySchema)
  if ('error' in query) return query.error
  const got = await storesOf(c).outbox.items(viewerOf(c), id.data, query.ok)
  if ('refused' in got) return apiError(got.refused.code)
  return apiJson(ActionItemsPageSchema.parse(got.page))
}
