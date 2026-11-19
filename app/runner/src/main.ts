// The root runner (P3 R1): runs as root in the container. It serves the Worker on 8080, owns every run token in memory,
// runs the loopback proxy, and starts one process per session as that session's own OS user. It never loads the SDK.
// Without the real guards (R2) it refuses to start.
import { fileURLToPath } from 'node:url'
import { createProxy } from './proxy/server.ts'
import { readPeerUid } from './proxy/proc-net.ts'
import { createRoot } from './server/app.ts'
import { readMemory } from './server/memory.ts'
import { productionSessionUsers } from './server/production.ts'
import { forkSession } from './server/session-host.ts'

const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }))

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

const port = Number(process.env.PORT ?? 8080)
const proxyPort = Number(process.env.PROXY_PORT ?? 8081)
// The Worker's egress: one upstream base URL, given at start. Not a secret (the egress checks every run token).
const upstream = new URL(required('EGRESS_URL'))

const users = productionSessionUsers()
// The bundle puts the session entry next to this one (dist/main.mjs, dist/session/main.mjs).
const sessionEntry = fileURLToPath(new URL('./session/main.mjs', import.meta.url))

const root = createRoot({
  users,
  spawnSession: forkSession(sessionEntry),
  proxyPort,
  stopGraceMs: 10_000,
  runTimeoutMs: 30 * 60_000,
  memory: readMemory,
  log,
})

const proxy = createProxy({ upstream, lookupUid: (s) => readPeerUid(s), tokenForUid: root.tokenForUid, log })

proxy.listen(proxyPort, '127.0.0.1', () => log({ type: 'proxy_listening', port: proxyPort }))
root.server.listen(port, () => log({ type: 'runner_listening', port }))

// SIGTERM: every live run gets interrupt(), flush, end (the session's stop path), then the root exits.
process.once('SIGTERM', () => {
  log({ type: 'sigterm', live: root.liveCount() })
  root.server.close()
  void root.stopAll().then(() => {
    proxy.close()
    process.exit(0)
  })
})
