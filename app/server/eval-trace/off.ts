// What `@eval-trace` resolves to in every build but the eval build (vite.config.ts): the eval trace switched off, so
// ./on.ts never enters their module graph, whatever imports it. Same exports as that file (the `satisfies`-style types
// keep them in step), with values that do nothing. check-product-build.mjs fails the product and test builds on the
// eval trace's module or canary, so this file must never contain the canary.
type Real = typeof import('./on.ts')

export const EVAL_TRACE_CANARY: Real['EVAL_TRACE_CANARY'] = ''
/** Not the eval build: the version signal names the product or test flavor instead. */
export const EVAL_BUILD_FLAVOR: Real['EVAL_BUILD_FLAVOR'] = null
