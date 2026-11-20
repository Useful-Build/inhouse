// The deny egress (HTTP catch-all, p3-design 7): plain HTTP from the container to anywhere but `egress.internal` is
// refused. Logged with the method only (never the host, path or a header).
import { WorkerEntrypoint } from 'cloudflare:workers'

export function denyEgress(request: Request, log: (entry: Record<string, unknown>) => void): Response {
  log({ event: 'egress_denied', method: request.method })
  return new Response('Plain HTTP is not allowed from the container.', { status: 403, headers: { 'content-type': 'text/plain' } })
}

export class DenyEgress extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return denyEgress(request, e => console.log(e))
  }
}
