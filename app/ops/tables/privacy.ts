// P8a F2's record of Shopify's privacy requests (0601, server/webhooks/shopify-privacy). No member id: a request names a
// Shopify customer (by Shopify id, never an email or phone), not a team member, so a person deletion has nothing here.
// Kept while the deployment lives as the record that each request was answered; the Shopify ids it names are cleared
// when the runbook closes it (route 94). Not exported: an operations record. A backup holds an open request's ids for
// the R2 lifecycle's 30 days.
import type { TableEntry } from './types.ts'

export const privacyTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'privacy_requests', retention: 'config', personKeys: [], export: false },
]
