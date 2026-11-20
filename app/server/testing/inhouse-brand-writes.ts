// The brand_data writes the Inhouse team may make, under a live grant and audited (item 19, Wasim 2026-11-20): a closed
// list, the one oracle both the matrix's unit tests (server/auth/matrix.test.ts) and the e2e route invariants
// (e2e/api/routes.spec.ts) read. P3: forgetting a team fact (row 45). Every other brand_data or personal write stays
// closed to the Inhouse team. Plain data, no imports, so the Playwright specs can load it.
export const INHOUSE_BRAND_WRITES: readonly string[] = ['PUT /api/memory/brand/:id/forgotten']
