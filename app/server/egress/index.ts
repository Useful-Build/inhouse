// The egress (`egress.internal`, p3-design section 8): the container's one way out, per call. Owner: W3 (p3-w3.md).
// PR0's stub answers every call 503 until W3 replaces this file. No Runner registers it as an intercept yet.
import { WorkerEntrypoint } from 'cloudflare:workers'

export class Egress extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    return new Response('not built', { status: 503 })
  }
}
