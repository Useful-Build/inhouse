// What a client entry file (client.demo.ts or client.product.ts) gives the app. `src/agent/index.ts` imports the one the
// build picked through the `@client` alias, so the other never reaches the bundle. Types only: nothing here runs, so this
// file is in the product build's module graph as nothing at all.
import type { AgentClient, DemoContext, Scenario } from './types'

/**
 * The demo's switches: what the dev switcher, `?demo`, Reset demo and the data override use. They exist only in the demo
 * build; the real client has none of them.
 */
export interface DemoControls {
  /** Stage comes from the plan in production, scenario from real state. Tells listeners when it changes. */
  setDemo(ctx: DemoContext): void
  /** Clear every state change. */
  reset(): void
  /** The scenarios the switcher lists. */
  readonly scenarios: readonly Scenario[]
  /** True when the brand or channels came from the test override (`inhouse.demo.data.v1`): only a reload drops them. */
  readonly dataOverrideActive: boolean
  /** When this demo started (epoch ms): set at first load and by Reset demo. The demo clock counts from it (demo-clock.ts). */
  demoStartedAt(): number
}

export interface ClientEntry {
  agent: AgentClient
  /** The demo's switches. Null in the product build: `?demo`, the switcher, Reset demo and the tour's demo steps then render nothing. */
  demo: DemoControls | null
  /** Now as epoch ms: the demo clock in the demo, the real clock in the product. Everything else asks here, never `Date.now()` for a shown time. */
  now(): number
}
