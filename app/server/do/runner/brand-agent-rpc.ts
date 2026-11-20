// The BrandAgent as the pool's parts call it (the Runner's exit report, the drain and warm-up routes, the pool
// signals). TEMPORARY adapter: the BrandAgent class gets these RPC methods in W1's next PR; until then its stub type
// has none, so the stub is read through the `BrandAgentRpc` port. Drop the cast once the class implements the port.
import type { BrandAgentRpc } from '../brand-agent/ports.ts'

export const brandAgentRpc = (env: Pick<Env, 'BRAND_AGENT'>): BrandAgentRpc =>
  env.BRAND_AGENT.getByName('brand') as unknown as BrandAgentRpc
