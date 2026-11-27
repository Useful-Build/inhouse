// Routes 150 and 151 (Stage 1 M3-C, N26): the Inhouse ceiling, the page "What the agent can do". `GET /api/ceiling`:
// the Inhouse team and admins read every write operation with its row (members never: the matrix answers 403).
// `PUT /api/ceiling/:operation`: the Inhouse team alone sets one operation's whole row at the `rev` it read (`ifRev`),
// through the store (api/ceiling-store.ts), which holds the change's one batch with its audit line.
//
// Writes stay off (N2): a PUT is refused `writes_off` unless editing is on in this build (`CEILING_EDIT_ON`, in the
// store, which checks it again inside `set`, #520). The eval door sets rows its own way.
import { CeilingListSchema, UpdateCeilingInputSchema } from '../../shared/contract/ceiling.ts'
import type { CeilingList } from '../../shared/contract/ceiling.ts'
import { readBody, storesOf, writer } from '../db/handler-kit.ts'
import { apiError, apiJson } from '../http.ts'
import { operationEntry } from '../outbox/operations/index.ts'
import type { Handler } from '../routes.ts'

/** The two handlers. Whether editing is on is the store's (`Stores.ceiling.editOn`), which `set` checks again. */
export function ceilingHandlers(): { get: Handler; put: Handler } {
  return {
    /** Route 150: every operation's row; `can.edit` for the Inhouse team while editing is on (display only). */
    async get(c) {
      const on = storesOf(c).ceiling.editOn()
      const list: CeilingList = { items: await storesOf(c).ceiling.list(), can: { edit: on && c.principal.kind === 'inhouse' }, writesOff: !on }
      return apiJson(CeilingListSchema.parse(list))
    },
    /**
     * Route 151: the operation's whole row at `ifRev`. 403 `writes_off` while editing is off; 404 for a key that names
     * no operation; 409 with the row as it is now when stale.
     */
    async put(c) {
      // The matrix lets only the Inhouse team through (row 151); anything else here is a wiring bug.
      if (c.principal.kind !== 'inhouse') throw new Error('ceiling: only the Inhouse team reaches route 151')
      if (!storesOf(c).ceiling.editOn()) return apiError('forbidden', { reason: 'writes_off' })
      const operation = operationEntry(c.params.operation ?? '')?.key
      if (!operation) return apiError('not_found')
      const body = await readBody(c.request, UpdateCeilingInputSchema)
      if ('error' in body) return body.error
      const { ifRev, ...values } = body.ok
      const done = await storesOf(c).ceiling.set({ operation, ifRev, ...values }, writer(c))
      if ('writesOff' in done) return apiError('forbidden', { reason: 'writes_off' })
      if ('conflict' in done) return apiError('conflict', { current: done.conflict })
      return apiJson(done.ok)
    },
  }
}

const handlers = ceilingHandlers()
export const getCeiling: Handler = handlers.get
export const putCeiling: Handler = handlers.put
