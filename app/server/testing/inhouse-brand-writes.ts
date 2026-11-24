// The brand_data writes the Inhouse team may make, under a live grant and audited (item 19, Wasim 2026-11-20): a closed
// list, the one oracle both the matrix's unit tests (server/auth/matrix.test.ts) and the e2e route invariants
// (e2e/api/routes.spec.ts) read. P3: forgetting a team fact (row 45). Every other brand_data or personal write stays
// closed to the Inhouse team. Plain data, no imports, so the Playwright specs can load it.
// P4 (wave-4 PR0): the routine rows (routes.ts rows 53 to 56), Today's set-aside (row 58) and the Library's delete
// and restore (rows 65 and 66). shared/contract/audit.test.ts keeps this list and the
// support.access write pairs equal. P6a (PR0): approving or rejecting a waiting team fact (row 78).
export const INHOUSE_BRAND_WRITES: readonly string[] = [
  'PUT /api/memory/brand/:id/forgotten',
  'PUT /api/routines/:id/enabled', 'POST /api/routines/:id/run', 'POST /api/routines/:id/delete', 'POST /api/routines/:id/restore',
  'PUT /api/today/:id/aside',
  'POST /api/library/delete', 'POST /api/library/restore',
  'PUT /api/memory/brand/:id/approved',
]
