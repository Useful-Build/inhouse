// The one place the app picks its agent. `@client` is the demo entry or the product entry, chosen by the build mode
// (vite.config.ts; tsconfig.app.json and vitest.config.ts name the demo one). Nothing else imports the mock.
import entry from '@client'
import type { ClientEntry, DemoControls } from './client-entry'
import type { AgentClient } from './types'
import { setBrandZone, setNow } from '../state/display'

// Typed as the interface, not as the entry's own (narrower) type: the demo entry's `agent` is a MockAgent and its `demo`
// is never null, so a consumer reading those would type-check a call the product build throws on.
const client: ClientEntry = entry
// display.ts reads "now" from here when asked, so no import order matters (the mock imports display).
setNow(client.now)
// The product shows times in the brand's zone once its settings load; the demo keeps the device's.
setBrandZone(client.demo ? () => undefined : () => client.agent.getSnapshot().settings['g:tz'])

export const agent: AgentClient = client.agent
/** The demo's switches, or null in the product build. */
export const demo: DemoControls | null = client.demo
/** Now as epoch ms: the demo clock in the demo, the real clock in the product. */
export const now = entry.now
export * from './types'
