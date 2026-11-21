// A health signal (P2 plan, "The health route"): a name and a check. Each phase adds its own to signals/index.ts. A
// check reads through the request's stores (a handler's env has no D1 or R2) and answers ok or not, with a short detail
// that never holds brand data (no names, emails, values: a count, a version, a migration name at most).
import type { HandlerEnv } from '../../routes.ts'
import type { Stores } from '../../db/stores.ts'

export interface SignalResult {
  ok: boolean
  detail?: string
}

export interface Signal {
  name: string
  check(ctx: { env: HandlerEnv; stores: Stores }): Promise<SignalResult>
}
