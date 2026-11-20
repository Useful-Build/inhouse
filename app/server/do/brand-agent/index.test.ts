// The BrandAgent class on PR 2a: the model gate isn't built, so it fails closed. Ways it can fail: a model call is
// admitted (`granted`), or a renew or release of any call answers anything but `gone` (the egress then aborts it).
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('no model call can run before the gate (PR 2b)', () => {
  it('admit answers busy (503 for that call); renew and release answer gone', async () => {
    const agent = env.BRAND_AGENT.getByName(`gate-closed-${Math.random()}`)
    const worst = { model: 'claude-sonnet-5-5', inputTokens: 10, maxTokens: 10, modifiers: {}, micro: 1 }
    const usage = { inputTokens: 1, outputTokens: 1, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, webSearches: 0, micro: 1 }
    expect(await agent.admitModelCall('t_AAAAAAAAAAAAAAAAAAAAAA', 'call-1', worst)).toEqual({ busy: true })
    expect(await agent.renewModelCall('t_AAAAAAAAAAAAAAAAAAAAAA', 'call-1', usage)).toEqual({ gone: true })
    expect(await agent.releaseModelCall('t_AAAAAAAAAAAAAAAAAAAAAA', 'call-1', { usage, cut: false })).toEqual({ gone: true })
  })
})
