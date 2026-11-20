// The demo's switches over the mock. Only the demo entry (client.demo.ts) imports this file: the product build has no demo
// controls (scripts/check-product-build.mjs fails it if they appear).
import type { DemoControls } from './client-entry'
import { dataOverrideActive } from './mock'
import type { MockAgent } from './mock'
import { SCENARIOS } from './types'

/** A unique string the product build check looks for: it must never be in the product build. */
export const DEMO_CONTROLS_MARKER = 'inhouse-canary:demo-controls'

export const demoControlsFor = (mock: MockAgent): DemoControls & { readonly marker: string } => ({
  marker: DEMO_CONTROLS_MARKER,
  setDemo: ctx => mock.setDemo(ctx),
  reset: () => mock.reset(),
  scenarios: SCENARIOS,
  dataOverrideActive,
  demoStartedAt: () => mock.demoStartedAt(),
})
