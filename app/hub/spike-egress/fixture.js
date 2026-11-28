// Stand-in for the public internet: every outbound request in this spike that is allowed to leave lands here.
// It answers any host, so a request that "reached the internet" is visible. Log is a counter the test reads over RPC.
import { WorkerEntrypoint } from 'cloudflare:workers'

const log = []

export class Log extends WorkerEntrypoint {
  entries() { return log.slice() }
  clear() { log.length = 0 }
}

export default {
  async fetch(req) {
    const url = new URL(req.url)
    const auth = req.headers.get('Authorization')
    log.push({ host: url.hostname, path: url.pathname, method: req.method, auth })
    if (url.hostname === 'api.fixture.test' && url.pathname === '/items') {
      if (!auth) return new Response('no key', { status: 401 })
      return Response.json({ items: [{ id: 1, name: 'widget' }] })
    }
    return new Response(`reached ${url.hostname}`, { status: 200 })
  },
}
