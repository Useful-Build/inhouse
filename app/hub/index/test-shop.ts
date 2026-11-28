// The read call's test shop override (contract.ts `CallToolOptions.testShopHost`), decided as a plain function so the node
// project tests both builds: the deployable hub (`__INHOUSE_HUB_TEST__` false) and the test build. The entrypoint
// (index.ts) passes `testBuild` as the guard written out in full and `registered` from the test seam, which it imports
// only inside that guard. Fail closed: an override the hub can't honour is `invalid_args`, never a read of SHOPIFY_SHOP.
import type { HubResult } from './contract'
import { err } from './errors'
import { CallToolOptionsSchema } from './schemas'

/** What a call reads: `shop` null is the hub's own SHOPIFY_SHOP (no override asked for); else the override's handle. */
export type ShopChoice = { shop: string | null }

export function decideTestShop(options: unknown, testBuild: boolean, registered: (host: string) => boolean): HubResult<ShopChoice> {
  if (options === undefined) return { ok: true, value: { shop: null } }
  const parsed = CallToolOptionsSchema.safeParse(options)
  if (!parsed.success) return err('invalid_args', 'options')
  // Stage 1 M4 (M4-A): `propose` (M4-K3) and `name` (M4-T) are frozen in the contract before their owners build them:
  // refused here as an unknown option was, so a call that sends one never runs as if it hadn't.
  if (parsed.data.propose !== undefined || parsed.data.name !== undefined) return err('invalid_args', 'options')
  const host = parsed.data.testShopHost
  if (host === undefined) return { ok: true, value: { shop: null } }
  if (!testBuild) return err('invalid_args', 'testShopHost')
  if (!registered(host)) return err('invalid_args', 'testShopHost')
  return { ok: true, value: { shop: host.slice(0, -'.myshopify.com'.length) } }
}
