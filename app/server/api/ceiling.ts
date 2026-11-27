// Routes 150 and 151 (Stage 1 M3-C, N26): the Inhouse ceiling, the page "What the agent can do". `GET /api/ceiling`:
// the Inhouse team and admins read every write operation with its row (members never: the matrix answers 403).
// `PUT /api/ceiling/:operation`: the Inhouse team alone sets one operation's whole row at the `rev` it read (`ifRev`),
// through the store (api/ceiling-store.ts), which holds the change's one batch with its audit line.
//
// Writes stay off (N2): a PUT is refused `writes_off` unless editing is on in this build. `CEILING_EDIT_ON` is false in
// every deployable build until M3-J flips it after the paid write-injection run; the test build turns it on for its
// own specs (the build's flag and its switch, as the test-fakes hook is gated). The eval door sets rows its own way.
import { CeilingListSchema, UpdateCeilingInputSchema } from '../../shared/contract/ceiling.ts'
import type { CeilingList } from '../../shared/contract/ceiling.ts'
import { readBody, storesOf, writer } from '../db/handler-kit.ts'
import { apiError, apiJson } from '../http.ts'
import { operationEntry } from '../outbox/operations/index.ts'
import type { Handler, HandlerContext } from '../routes.ts'

declare const __INHOUSE_TEST_BUILD__: boolean
declare const __INHOUSE_EVAL_BUILD__: boolean

/**
 * Whether the Inhouse team may change the ceiling in a deployable build (N2, N26). Off until M3-J flips it, after the
 * paid write-injection run shows zero bypasses. Only M3-J changes this line.
 */
export const CEILING_EDIT_ON = false

/** Editing is on for this request: the constant, or the test build compiled in and switched on (never the eval build). */
const editOnIn = (env: unknown, testBuild: boolean): boolean =>
  CEILING_EDIT_ON || (testBuild && (env as { INHOUSE_TEST_BUILD?: unknown }).INHOUSE_TEST_BUILD === '1')

/**
 * The two handlers. `testBuild`: whether this build compiles the test build's switch in, as the test-fakes hook's
 * `compiledIn` says it (the test build, never the deployed eval build). A parameter so the unit tests stand in for each
 * build; vitest compiles both defines `false`, the product-shaped build.
 */
export function ceilingHandlers(testBuild: boolean = __INHOUSE_TEST_BUILD__ && !__INHOUSE_EVAL_BUILD__): { get: Handler; put: Handler } {
  const editOn = (c: HandlerContext) => editOnIn(c.env, testBuild)
  return {
    /** Route 150: every operation's row; `can.edit` for the Inhouse team while editing is on (display only). */
    async get(c) {
      const on = editOn(c)
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
      if (!editOn(c)) return apiError('forbidden', { reason: 'writes_off' })
      const operation = operationEntry(c.params.operation ?? '')?.key
      if (!operation) return apiError('not_found')
      const body = await readBody(c.request, UpdateCeilingInputSchema)
      if ('error' in body) return body.error
      const { ifRev, ...values } = body.ok
      const done = await storesOf(c).ceiling.set({ operation, ifRev, ...values }, writer(c))
      if ('conflict' in done) return apiError('conflict', { current: done.conflict })
      return apiJson(done.ok)
    },
  }
}

const handlers = ceilingHandlers()
export const getCeiling: Handler = handlers.get
export const putCeiling: Handler = handlers.put
