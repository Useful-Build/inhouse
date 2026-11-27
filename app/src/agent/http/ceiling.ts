// Stage 1 M3-C (N26): the Inhouse ceiling over HTTP (routes 150 and 151), the page "What the agent can do". No zod here
// (the entry's size budget, schemas.ts): the transport parses each answer with the lazily loaded schemas.
import type { CeilingList, CeilingRow, UpdateCeilingInput } from '../../../shared/contract/ceiling'
import { AgentError } from '../types'
import type { Transport } from './transport'

const enc = encodeURIComponent

/** Route 150: every write operation with its row, what this viewer may change and whether editing is off in this build. */
export const readCeiling = (http: Transport): Promise<CeilingList> =>
  http.call({ method: 'GET', path: '/api/ceiling', schema: 'ceiling' })

/**
 * Route 151: one operation's whole row at the `rev` it was read at; the row as it is after. A stale change's `current`
 * is passed on only when it parses as a row; else it's left out and the page reads the list again. (Here, not in the
 * client: the client loads with Today, under its size budget.)
 */
export async function putCeilingRow(http: Transport, operation: string, input: UpdateCeilingInput): Promise<CeilingRow> {
  const k = await http.contract()
  try {
    return await http.call({ method: 'PUT', path: `/api/ceiling/${enc(operation)}`, schema: 'ceilingRow', json: k.BODIES.updateCeiling.parse(input) })
  } catch (e) {
    if (!(e instanceof AgentError) || e.code !== 'conflict' || e.current === undefined) throw e
    const current = k.ANSWERS.ceilingRow.safeParse(e.current)
    throw new AgentError('conflict', e.message, { ...(e.reason ? { reason: e.reason } : {}), ...(current.success ? { current: current.data } : {}) })
  }
}
