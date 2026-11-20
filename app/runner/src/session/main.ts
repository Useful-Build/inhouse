// The session process entry, spawned by the root runner as the session's own OS user with `sessionEnv()` as its whole
// environment and the local channel (its own stdin and stdout; src/session/channel.ts) as its only link to the root.
// It holds no token. Logs go to stderr only: stdout is the channel.
import { productionQueryGuards } from '../server/production.ts'
import { openRootChannel } from './channel.ts'
import { runSession, type QueryFn } from './core.ts'

// The SDK calls process.report.getReport(), which reverse-resolves every open socket and, with internet off, waits on
// DNS timeouts (P0 S1 and S2: 60 to 140 s per query()). Must be set before the SDK loads.
// (@types/node doesn't declare it yet.)
;(process.report as typeof process.report & { excludeNetwork: boolean }).excludeNetwork = true

// The guards first: without them nothing else happens.
const guards = productionQueryGuards()
const channel = openRootChannel()
const { query } = await import('@anthropic-ai/claude-agent-sdk')

// The loopback proxy (sessionEnv() sets it): the store and files routes, with no token here.
const proxyUrl = process.env.INHOUSE_PROXY_URL
if (!proxyUrl) throw new Error('INHOUSE_PROXY_URL is not set')

await runSession({ channel, query: query as QueryFn, guards, cwd: process.cwd(), env: process.env, io: { fetch, proxyUrl } })
// Flush the terminal event, then go: the root decides the run's end once this process and its pipes have closed.
await channel.close()
process.exit(0)
