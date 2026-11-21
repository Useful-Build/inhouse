// The brand_data writes the Inhouse team may make, under a live grant and audited (item 19, Wasim 2026-11-20): a closed
// list, the one oracle both the matrix's unit tests (server/auth/matrix.test.ts) and the e2e route invariants
// (e2e/api/routes.spec.ts) read. P3: forgetting a team fact (row 45). Every other brand_data or personal write stays
// closed to the Inhouse team. Plain data, no imports, so the Playwright specs can load it.
// P4 (wave-4 PR0): the routine rows (p4-w2.md routes 51 to 54), Today's set-aside (p4-w3.md route 56) and the
// Library's delete and restore (p4-w5.md routes 63 and 64). shared/contract/audit.test.ts keeps this list and the
// support.access write pairs equal.
export const INHOUSE_BRAND_WRITES: readonly string[] = [
  'PUT /api/memory/brand/:id/forgotten',
  'PUT /api/routines/:id/enabled', 'POST /api/routines/:id/run', 'POST /api/routines/:id/delete', 'POST /api/routines/:id/restore',
  'PUT /api/today/:id/aside',
  'POST /api/library/delete', 'POST /api/library/restore',
]
