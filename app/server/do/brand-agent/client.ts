// The one BrandAgent of the brand, as the API handlers and the other objects reach it (p3-design section 1).
import type { BrandAgent } from './index.ts'

export const brandAgent = (env: Pick<Env, 'BRAND_AGENT'>): DurableObjectStub<BrandAgent> => env.BRAND_AGENT.getByName('brand')
