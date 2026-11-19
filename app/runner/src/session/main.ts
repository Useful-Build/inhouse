// The session process entry, spawned by the root runner as the session's own OS user with `sessionEnv()` as its whole
// environment and the IPC channel as its only link to the root. It holds no token.
import { productionQueryGuards } from '../server/production.ts'
import { runSession, type QueryFn, type SessionChannel } from './core.ts'

// The SDK calls process.report.getReport(), which reverse-resolves every open socket and, with internet off, waits on
// DNS timeouts (P0 S1 and S2: 60 to 140 s per query()). Must be set before the SDK loads.
// (@types/node doesn't declare it yet.)
;(process.report as typeof process.report & { excludeNetwork: boolean }).excludeNetwork = true

const ipcSend = process.send?.bind(process)
if (ipcSend === undefined) {
  console.error('session: no IPC channel; the root runner starts this process')
  process.exit(2)
}
const send = ipcSend

// IPC sends are async and ordered: the process disconnects only after the last one is out, so the terminal event
// can't be dropped.
let lastSend: Promise<void> = Promise.resolve()
const channel: SessionChannel = {
  send: (m) => {
    lastSend = new Promise((r) => send(m, undefined, {}, () => r()))
  },
  onMessage: (handler) => process.on('message', handler),
}

const guards = productionQueryGuards()
const { query } = await import('@anthropic-ai/claude-agent-sdk')

await runSession({ channel, query: query as QueryFn, guards, cwd: process.cwd(), env: process.env })
await lastSend
process.disconnect?.()
