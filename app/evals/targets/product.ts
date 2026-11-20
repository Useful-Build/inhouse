// The product target's guard. PR 1 ships the guard and the capability line only: the chat path (sign in as the eval
// principal, seed memory, route 29, route 33, the server's settled cost) is PR 2's, once W1 PR 4, W5 PR 2 and the Q2
// deployment exist. Nothing here makes a network call.
import type { Target } from '../types.ts'
import { S5_PEOPLE } from '../s5-fixtures.ts'

export class ProductTargetRefusal extends Error {
  override name = 'ProductTargetRefusal'
}

export interface ProductTargetOptions {
  paid: boolean
  budgetUsd?: number
  env: Record<string, string | undefined>
  fetch?: typeof fetch
}

/** Env flag names: the eval deployment sets both. The first marks the brand as an eval brand, the second names its origin. */
export const EVAL_BRAND_FLAG = 'INHOUSE_EVAL_BRAND'
export const EVAL_ORIGIN_VAR = 'INHOUSE_EVAL_ORIGIN'

export function createProductTarget(opts: ProductTargetOptions): Target {
  if (!opts.paid) throw new ProductTargetRefusal('the product target spends real money: pass --paid and --budget <usd>')
  if (!(typeof opts.budgetUsd === 'number' && opts.budgetUsd > 0)) throw new ProductTargetRefusal('the product target needs --budget <usd> above zero')
  if (opts.env[EVAL_BRAND_FLAG] !== '1') throw new ProductTargetRefusal(`refusing: ${EVAL_BRAND_FLAG}=1 is not set, so the brand isn't marked as an eval brand`)
  if (!opts.env[EVAL_ORIGIN_VAR]) throw new ProductTargetRefusal(`refusing: ${EVAL_ORIGIN_VAR} is not set`)
  return {
    name: 'product',
    // The eval brand's members map here in PR 2; S5's keys stand in until then.
    people: S5_PEOPLE,
    // P3 builds none of the shop and mail connectors or routines: the cases that need them report as not run (phase P4/P5).
    provides: new Set<string>(),
    async seed() {
      throw new ProductTargetRefusal('the product target\'s chat path lands in PR 2 (needs W1 PR 4, W5 PR 2 and the Q2 deployment)')
    },
  }
}
