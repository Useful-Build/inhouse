// Turns, runs and traces over HTTP (P3, p3-design section 3, routes 29 to 33). Plain code, no zod (the entry's size
// budget, schemas.ts).
import type { ActiveRun, ChatSendInput, SendTurnResult, Trace } from '../types'
import { AgentError } from '../types'
import { NOT_FOUND } from '../../../shared/contract/error-codes'
import type { Contract, Transport } from './transport'

/** Route 29. The body is built from the shared schema, so a send the server would refuse as `invalid` never leaves. */
export function postTurn(http: Transport, k: Contract, chatId: string, input: ChatSendInput): Promise<SendTurnResult> {
  const body = k.BODIES.sendTurn.safeParse({
    clientTurnKey: input.clientTurnKey, text: input.text, ...(input.quote !== undefined ? { quote: input.quote } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}), model: input.model,
    ...(input.replacesRun !== undefined ? { replacesRun: input.replacesRun } : {}), ...(input.attachments ? { attachments: input.attachments } : {}),
  })
  if (!body.success) return Promise.reject(new AgentError('invalid', "That message can't be sent. Check it and try again."))
  return http.call({ method: 'POST', path: `/api/chats/${encodeURIComponent(chatId)}/turns`, schema: 'sendTurn', json: body.data })
}

/** Routes 30 and 31: ends that turn (and keeps the session), or the hard stop of that turn only. */
export const postTurnAction = (http: Transport, turnId: string, action: 'interrupt' | 'stop'): Promise<unknown> =>
  http.call({ method: 'POST', path: `/api/turns/${encodeURIComponent(turnId)}/${action}`, schema: 'ack' })

/** Route 32: the runs the person can attach to (the live one, and an ended one whose turns aren't all stored yet). */
export const readActiveRuns = async (http: Transport): Promise<ActiveRun[]> => (await http.call({ method: 'GET', path: '/api/runs/active', schema: 'activeRuns' })).runs

/** Route 33: a run's or a turn's steps. Null when there are none to show (a 404). */
export async function readTrace(http: Transport, id: string): Promise<Trace | null> {
  try { return await http.call({ method: 'GET', path: `/api/traces/${encodeURIComponent(id)}`, schema: 'trace' }) } catch (e) {
    if (e instanceof AgentError && e.code === NOT_FOUND) return null
    throw e
  }
}
