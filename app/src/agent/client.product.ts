// The product client entry: the HTTP stub (src/agent/http/), no demo controls, the real clock. `vite build --mode product`
// picks this one, so the mock, the sample data and the demo clock never reach the bundle.
// First: it must run before the HTTP client builds a schema (see shared/contract/jitless.ts).
import '../../shared/contract/jitless'
import type { ClientEntry } from './client-entry'
import { HttpAgent } from './http'

export default {
  agent: new HttpAgent(),
  demo: null,
  now: () => Date.now(),
} satisfies ClientEntry
