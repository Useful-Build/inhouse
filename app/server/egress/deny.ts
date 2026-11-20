// The deny egress (HTTP catch-all, p3-design section 7). Owner: W3 (p3-w3.md). PR0's stub refuses every call (503)
// until W3 replaces this file.
import { WorkerEntrypoint } from 'cloudflare:workers'

export class DenyEgress extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    return new Response('not built', { status: 503 })
  }
}
