// One recorded upstream per read-side Shopify case (evals/read-side/, RS-SF1 and RS-SF2), by the case's shop host, each with the
// case's planted text in the field its placement names, on the store-data datasets' base store (../exfiltration/datasets.ts,
// reused as it is). The hub's test build registers `READ_SIDE_UPSTREAMS` in hub/testing/index.ts like `STORE_DATA_UPSTREAMS`:
// that line is the orchestrator's (the PR body). Imports no npm package (bundled into the hub).
import { READ_SIDE_CASES } from '../../../../../evals/read-side/cases'
import { plantedFieldOf, readSideShopOf } from '../../../../../evals/read-side/shops'
import { createShopifyUpstream } from '../../server'
import { planted } from '../exfiltration/datasets'

export type Upstream = (req: Request) => Promise<Response>

export function readSideUpstreams(nowMs: number = Date.now()): Record<string, Upstream> {
  return Object.fromEntries(READ_SIDE_CASES.filter(c => c.source === 'shopify').map(c => [readSideShopOf(c.id), createShopifyUpstream(planted(nowMs, plantedFieldOf(c.placement), c.text))]))
}

export const READ_SIDE_UPSTREAMS: Record<string, Upstream> = readSideUpstreams()
