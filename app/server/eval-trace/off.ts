// What `@eval-trace` resolves to in every build but the eval build (vite.config.ts): the eval trace switched off, so
// ./on.ts never enters their module graph, whatever imports it. Same exports as that file (the `Real[...]` types keep
// them in step), with values that keep, read and schedule nothing. check-product-build.mjs fails the product and test
// builds on the eval trace's module or canary, so this file must never contain the canary.
type Real = typeof import('./on.ts')

export const EVAL_TRACE_CANARY: Real['EVAL_TRACE_CANARY'] = ''
/** Not the eval build: the version signal names the product or test flavor instead. */
export const EVAL_BUILD_FLAVOR: Real['EVAL_BUILD_FLAVOR'] = null
export const IO_TRACE_MAX_BYTES: Real['IO_TRACE_MAX_BYTES'] = 0
export const IO_TTL_MS: Real['IO_TTL_MS'] = 0
export const IO_TTL_TASK: Real['IO_TTL_TASK'] = ''
/** Reads no input. */
export const toolInput: Real['toolInput'] = () => ({ text: '', cut: true })
/** Keeps no input. */
export const ioRecord: Real['ioRecord'] = () => null
/** Reads no input. */
export const ioFrom: Real['ioFrom'] = () => null
/** No eval tasks. */
export const EVAL_TASKS: Real['EVAL_TASKS'] = {}
