// The Runner Durable Object with its container (P3, p3-design section 7): `runner-0` .. `runner-<N-1>`. Owner: W2
// (p3-w2.md). PR0's stub: the class exists so the Worker config can bind it to the container and migrate it; it never
// starts the container, and every call answers 503 `not_built` until W2 replaces this file.
import { DurableObject } from 'cloudflare:workers'
import { apiError } from '../../http.ts'

export class Runner extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return apiError('unavailable', { reason: 'not_built' })
  }
}
