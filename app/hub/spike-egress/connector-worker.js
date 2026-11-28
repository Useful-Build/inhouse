// Shape 2: a connector deployed as its own Worker, no route, reached by the hub over a service binding.
import { WorkerEntrypoint } from 'cloudflare:workers'

export class Connector extends WorkerEntrypoint {
  async direct(url) {
    const res = await fetch(url)
    return { status: res.status, body: await res.text() }
  }
}

export default { fetch() { return new Response(null, { status: 404 }) } }
