// A BrandAgent stand-in for P2 handlers' tests (P3 design 4.10): `BRAND_AGENT.getByName('brand')` answers an object that
// records each authority call, runs `onCall` at the moment of the call (so a test can read D1 as the object would see
// it) and throws when `fails` is set (a lost call). Test-only.
export interface AgentCall { method: string; args: unknown[] }
export function recordingAgent(o: { onCall?: (c: AgentCall) => Promise<void>; fails?: boolean } = {}) {
  const calls: AgentCall[] = []
  const record = (method: string) => async (...args: unknown[]) => {
    const c = { method, args }
    calls.push(c)
    await o.onCall?.(c)
    if (o.fails) throw new Error('rpc lost')
  }
  const agent = { onMemberRemoved: record('onMemberRemoved'), onGrantEnded: record('onGrantEnded'), onGrantCreated: record('onGrantCreated') }
  const env = { BRAND_AGENT: { getByName: () => agent } } as unknown as Pick<Env, 'BRAND_AGENT'>
  return { calls, env }
}
