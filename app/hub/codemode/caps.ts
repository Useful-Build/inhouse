// Code mode's caps and their fixed messages (P5 W2; caps per Wasim, 2026-11-21). No imports: the registry reads the
// two messages to keep them on a rate_limited result (every other tool error detail is rebuilt to the tool's name).

/** shopify_script_run calls per run id (a `server` scope counts per job). */
export const RUN_CAP = 50
/** shopify_script_run calls per brand (one Shopify SignIn) per UTC day. */
export const DAY_CAP = 300
export const RUN_CAP_TTL_MS = 60 * 60_000

export const RUN_CAP_MESSAGE = `Code mode has reached this run's limit of ${RUN_CAP} scripts. Answer with what you have, or use the other Shopify tools.`
export const DAY_CAP_MESSAGE = `Code mode has reached today's limit of ${DAY_CAP} scripts. It resets at midnight UTC.`
export const CAP_MESSAGES: readonly string[] = [RUN_CAP_MESSAGE, DAY_CAP_MESSAGE]

/** Calls a script may make, bytes it may read in all, its wall clock and its return size. */
export const MAX_CALLS = 10
export const MAX_READ_BYTES = 4 * 1024 * 1024
export const DEADLINE_MS = 20_000
export const MAX_RETURN_BYTES = 8 * 1024
export const LIMITS = { cpuMs: 1_000, subRequests: 20 } as const
/** A script error's text, as the model sees it. */
export const MAX_ERROR_CHARS = 500
/** The hub's own compatibility date (wrangler.hub.jsonc), so the sandbox runs on the runtime the hub was tested on. */
export const COMPATIBILITY_DATE = '2026-11-11'
