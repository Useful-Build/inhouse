// Turns off zod's code generation (zod docs: `z.config({ jitless: true })`). Zod 4 probes `new Function("")` when an
// object schema is built, and the product's CSP has no `unsafe-eval`, so the browser reports the probe as a violation
// (the test build and the product E2E fail on it). Every contract file imports this FIRST, before its own `z.object`
// runs, so the setting is in place whichever file a bundle reaches first. Cost: object parsing takes zod's plain path.
import { z } from 'zod'

z.config({ jitless: true })
