// The routine timings both the tick and the routines signal use. Kept apart from tick.ts so the signal (and the stores
// that serve it) import no handler code: scripts that load the stores under Node (scripts/sandbox/seed-remote.mjs)
// can't load the request path's Vite-only imports.
const MIN = 60_000

/** A slot is on time within this of its due instant (OC 2); a Run now has this long to start. */
export const ON_TIME_MS = 10 * MIN
/** A started slot is lost after this whatever its chat says: P6's 7-day question expiry plus a day (section 6b). */
export const BACKSTOP_MS = 8 * 24 * 60 * MIN
