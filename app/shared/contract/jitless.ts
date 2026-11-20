// Turns off zod's code generation (zod docs: `z.config({ jitless: true })`; `config` is the same function from zod's core).
// Zod 4 probes `new Function("")` when an object schema is built, and the product's CSP has no `unsafe-eval`, so the
// browser reports the probe as a violation (the test build and the product E2E fail on it). The product client entry
// (src/agent/client.product.ts) imports this FIRST, before its HTTP client builds any schema, so the setting is in place
// before the first `z.object` runs. Only the product imports it: the demo has no such CSP, and importing it from every
// contract file kept zod's whole classic namespace in Today's first load (+26 KB gzip, over the 240 KB budget).
// It imports `config` from zod's core, not `z` from zod, so it adds nothing but the call.
import { config } from 'zod/v4/core'

config({ jitless: true })
