// The one place the app picks its agent. `@client` is the demo entry or the product entry, chosen by the build mode
// (vite.config.ts; tsconfig.app.json and vitest.config.ts name the demo one). Nothing else imports the mock.
import entry from '@client'

export const agent = entry.agent
/** The demo's switches, or null in the product build. */
export const demo = entry.demo
/** Now as epoch ms: the demo clock in the demo, the real clock in the product. */
export const now = entry.now
export * from './types'
