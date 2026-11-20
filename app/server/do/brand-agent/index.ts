// The BrandAgent Durable Object (P3, p3-design section 4): one per brand, `env.BRAND_AGENT.getByName('brand')`. Owner:
// W1 (p3-w1.md). PR0's stub: the class exists so the Worker config can bind and migrate it; every call answers 503
// `not_built` until W1 replaces this file.
import { DurableObject } from 'cloudflare:workers'
import { apiError } from '../../http.ts'

export class BrandAgent extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return apiError('unavailable', { reason: 'not_built' })
  }
}
