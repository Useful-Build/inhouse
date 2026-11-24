// Shopify code mode, nightly (P5 W5 section 1, branch A): W2's four reference scripts (hub/codemode/measure/scripts.ts) run through
// the deployed hub's `shopify_script_run` against the read fixture store. Each result must equal the oracle computed from the
// store's recorded copy (hub/codemode/measure/oracle.ts, written apart from the scripts) and stay under 2 KiB. The store is
// seeded once and never changes, so the recorded copy is its truth. Prints case names and fixed texts only.
import { dataset } from '../../upstreams/shopify/recordings/fixture/dataset'
import type { Dataset } from '../../upstreams/shopify/dataset'
import { ASKED_AT, MAX_ANSWER_BYTES, MEASURE_CASES } from '../../../hub/codemode/measure/scripts'
import { lowestStock, openReturnsNotRestocked, refundsByProductAndReason, unfulfilledOverThreeDays } from '../../../hub/codemode/measure/oracle'
import type { NightlyHub } from './client'
import type { NightlyCase } from './cases'

const d = dataset as Dataset
const ORACLE: Record<string, unknown> = {
  'lowest-stock': lowestStock(d),
  'unfulfilled-3-days': unfulfilledOverThreeDays(d, ASKED_AT),
  'refunds-by-product-reason': refundsByProductAndReason(d),
  'open-returns-not-restocked': openReturnsNotRestocked(d),
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length

export function codeModeCases(hub: NightlyHub): NightlyCase[] {
  return MEASURE_CASES.map(c => ({
    name: `code mode: ${c.id} equals the oracle and stays under 2 KiB`,
    run: async () => {
      if (!(c.id in ORACLE)) return 'no oracle for this case'
      const r = await hub.callTool('shopify_script_run', { code: c.code })
      if (!r.ok) return `call: ${r.code}`
      const out = r.value.data as { result?: unknown; error?: unknown }
      if (out.error !== undefined) return 'the script failed'
      if (bytes(out.result) > MAX_ANSWER_BYTES) return `the answer is ${bytes(out.result)} bytes, over 2 KiB`
      // Same JSON in the same key order: both sides are plain JSON from fixed code, so the text compares exactly.
      return JSON.stringify(out.result) === JSON.stringify(ORACLE[c.id]) ? null : 'the answer differs from the oracle'
    },
  }))
}
