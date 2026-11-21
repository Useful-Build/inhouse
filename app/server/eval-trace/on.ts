// The eval trace (p3-eval-observability rev 2, rec 1 and 5), what `@eval-trace` resolves to in the eval build only
// (`vite build --mode product-eval`); every other build gets ./off.ts. Import it only as `@eval-trace`, never by its path.
// scripts/check-product-build.mjs fails the product and test builds on this module or its canary, and the eval build
// without them.

/** The string the bundle scan looks for. It rides in EVAL_BUILD_FLAVOR, so it stays in the eval build's bundle. */
export const EVAL_TRACE_CANARY: string = 'inhouse-eval-trace-canary-5d1e8a40'

/** The flavor the health route's version signal names in the eval build (server/ops/signals/core.ts). */
export const EVAL_BUILD_FLAVOR: string | null = `eval (${EVAL_TRACE_CANARY})`
