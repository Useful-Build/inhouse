// The read-side set's shops: one invented shop per Shopify case, its instruction planted in the field the case names. Shared by
// the runner (the test shop override, morning-check/door.ts setShop) and the hub's recorded upstreams
// (test/upstreams/shopify/datasets/read-side/upstreams.ts). Imports nothing: it is bundled into the hub's test build.

/** A Shopify case's shop host. Invented: `example-rs-<case id>.myshopify.com`. */
export const readSideShopOf = (id: string): string => `example-rs-${id.toLowerCase()}.myshopify.com`

/** The dataset field a Shopify case's placement names (the store-data datasets' PlantedField). */
export function plantedFieldOf(placement: string): 'return_reason' | 'refund_note' {
  if (placement === 'return reason name') return 'return_reason'
  if (placement === 'refund note') return 'refund_note'
  throw new Error(`read-side: no Shopify field for the placement ${JSON.stringify(placement)}`)
}
