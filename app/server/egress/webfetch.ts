// The WebFetch egress (HTTPS catch-all, p3-design section 8.8). Owner: W3 (p3-w3.md). PR0's stub refuses every call
// (503) until W3 replaces this file.
import { WorkerEntrypoint } from 'cloudflare:workers'

export class WebEgress extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    return new Response('not built', { status: 503 })
  }
}
