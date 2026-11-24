// Data and access (P8a row D): the retention row's next cleanup and "Export everything" (routes 95 and 96). Plain
// values and one pure function, no imports, so the client and the server read the same numbers (route 96's answer
// schema is data-access-check.ts, which the client loads with its other schemas).
//
// The retention periods themselves are the technical settings `d:chats` and `d:steps` (settings-table.ts): the
// Inhouse team writes them through route 12, Admins and members read them through route 11 and see them as text.

/** When the nightly cleanup (the `retention` due task, server/ops/retention-handlers.ts) runs: 03:30 UTC every day. */
export const RETENTION_AT = { hour: 3, minute: 30 } as const

/** The next nightly cleanup strictly after `nowMs`, in ms: today's 03:30 UTC if it's still ahead, else tomorrow's. */
export function nextCleanupMs(nowMs: number): number {
  if (!Number.isFinite(nowMs)) throw new Error('nextCleanupMs: nowMs must be a finite number')
  const d = new Date(nowMs)
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), RETENTION_AT.hour, RETENTION_AT.minute)
  return today > nowMs ? today : today + 86_400_000
}

/**
 * Route 95, `GET /api/data-access/export`: the brand's export for the caller as one NDJSON download (ops/export/export.ts's
 * format 1, `brandForCaller`: a header line listing every store in the registry, a line per row or file, then
 * `{ end: true, counts }`). The brand's shared data and the caller's own; never another person's personal rows. Admins,
 * and the Inhouse team under a live grant. A brand too big for one request is a 409 `conflict`, reason `too_large`.
 */
export const DATA_EXPORT_PATH = '/api/data-access/export'

/** Route 96, `GET /api/data-access/export/check`: whether route 95 would start now, and how big it is. Writes nothing. */
export const DATA_EXPORT_CHECK_PATH = '/api/data-access/export/check'

/** The download's name on a given UTC day: `inhouse-export-2026-11-24.ndjson`. */
export const dataExportFileName = (atMs: number): string => `inhouse-export-${new Date(atMs).toISOString().slice(0, 10)}.ndjson`
