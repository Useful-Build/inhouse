// One recorded upstream per store-data case, by the case's shop host (the hub's test build registers `STORE_DATA_UPSTREAMS` in
// hub/testing/index.ts, like `MORNING_CHECK_UPSTREAMS`: that line is the orchestrator's, in the W6 PR body). Datasets are built
// when this module loads, so a start of the hub gives fresh ages. Imports no npm package (bundled into the hub).
import { STORE_DATA_CASES, hostOf } from '../../../../../evals/exfiltration/store-data/cases'
import { createShopifyUpstream } from '../../server'
import { planted } from './datasets'

export type Upstream = (req: Request) => Promise<Response>

export function storeDataUpstreams(nowMs: number = Date.now()): Record<string, Upstream> {
  return Object.fromEntries(STORE_DATA_CASES.map(c => [hostOf(c.id), createShopifyUpstream(planted(nowMs, c.field, c.text))]))
}

export const STORE_DATA_UPSTREAMS: Record<string, Upstream> = storeDataUpstreams()
