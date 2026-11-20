// The table registry (P2 plan, "The table registry"): every D1 table, Durable Object store and R2 prefix with its
// retention class, person key and export flag. Orchestrator only. W2's first PR adds the entry type (tables/types.ts),
// P2's entries (tables/core.ts) and the completeness test; the orchestrator lists them here.
export const tables: readonly unknown[] = []
