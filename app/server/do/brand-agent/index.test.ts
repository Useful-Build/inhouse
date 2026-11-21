// The BrandAgent class answers the model gate's three calls through its RPC surface (the gate itself: gate.test.ts).
// Ways it can fail: a call on a turn the object doesn't run is admitted, or a renew or release of a call it never
// admitted answers anything but `gone` (the egress then aborts it).
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('the gate through the class (PR 2b)', () => {
  it('a turn the object does not run: admit answers busy (503 for that call); renew and release answer gone', async () => {
    const agent = env.BRAND_AGENT.getByName(`gate-rpc-${Math.random()}`)
    const worst = { model: 'claude-sonnet-5-5', inputTokens: 10, maxTokens: 10, modifiers: {}, micro: 1 }
    const usage = { inputTokens: 1, outputTokens: 1, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, webSearches: 0, micro: 1 }
    expect(await agent.admitModelCall('t_AAAAAAAAAAAAAAAAAAAAAA', 'call-1', worst)).toEqual({ busy: true })
    expect(await agent.renewModelCall('t_AAAAAAAAAAAAAAAAAAAAAA', 'call-1', usage)).toEqual({ gone: true })
    expect(await agent.releaseModelCall('t_AAAAAAAAAAAAAAAAAAAAAA', 'call-1', { usage, cut: false })).toEqual({ gone: true })
  })
})
