// The deny egress (p3-design 7): plain HTTP to anywhere is refused, logged with the method only.
import { describe, expect, it } from 'vitest'
import { denyEgress } from './deny.ts'

describe('DenyEgress', () => {
  it('refuses every method and logs no host, path or header', async () => {
    for (const method of ['GET', 'POST', 'HEAD']) {
      const logs: Record<string, unknown>[] = []
      const res = denyEgress(new Request('http://10.0.0.1:8080/secret?token=abc', { method, headers: { authorization: 'Bearer x' } }), e => void logs.push(e))
      expect(res.status).toBe(403)
      expect(logs).toEqual([{ event: 'egress_denied', method }])
    }
  })
})
