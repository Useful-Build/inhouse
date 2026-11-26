// Stage 1 M2-H: a read of the hub's Shopify account through the test-fakes hook's `hub` op. The hub gives a
// client-credentials account its connect date at its first token grant, and M2-D's sync copies that date into
// `connector_accounts` on a request; with no date the outbox refuses the request (`account_unavailable`). So a suite
// that seeds an action reads the account once first, as e2e/api/actions.spec.ts does. Used by e2e/real/actions-ui.spec.ts
// and the contract suite's real target. Named here, not in src/: scripts/check-icons.mjs reads any underscored string in
// src/ as an icon name. No Node imports, so src/ can import it.
export const SHOPIFY_READ = { op: 'hub', method: 'callTool', name: 'orders_search', args: { first: 1 } } as const
