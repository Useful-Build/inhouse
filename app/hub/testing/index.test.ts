import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { HUB_TEST_CANARY, testUpstreamFetch, testUpstreams } from './index'

describe('the test upstream seam', () => {
  test('the canary is the exact value scripts/check-hub-build.mjs looks for', () => {
    expect(HUB_TEST_CANARY).toBe('INHOUSE_HUB_TEST_CANARY_4b9e')
  })

  test.prop([fc.domain(), fc.webPath()])('an unregistered host answers 599 and names the host, never a real fetch', async (host, path) => {
    fc.pre(!testUpstreams.has(host))
    const res = await testUpstreamFetch(new Request(`https://${host}${path}`))
    expect(res.status).toBe(599)
    expect(await res.text()).toContain(`"${host}"`)
  })

  test('a registered host reaches its upstream', async () => {
    const host = 'example-fixture.myshopify.com'
    testUpstreams.set(host, async () => new Response('recorded', { status: 200 }))
    try {
      const res = await testUpstreamFetch(new Request(`https://${host}/admin/api/graphql.json`, { method: 'POST' }))
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('recorded')
    } finally {
      testUpstreams.delete(host)
    }
  })
})
