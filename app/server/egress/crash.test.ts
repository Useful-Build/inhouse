// The egress's last catch (P8a P-auth): a throw out of any route answers a fixed 500 and logs the error's name only. An
// uncaught throw would put its message (a store error, a parse error quoting a body) in the runtime's own exception log.
import { describe, expect, it } from 'vitest'
import type { EgressDeps } from './deps.ts'
import { handleEgress } from './index.ts'
import { egressRequest, NO_CAPTURE } from './testing/harness.ts'

const CANARY = 'CANARY-tool-input-7f3a'

describe('a throw out of the egress', () => {
  it('answers a fixed 500 and logs only the error name', async () => {
    const logs: Record<string, unknown>[] = []
    const deps = {
      rpc: { checkRunToken: async () => { throw new SyntaxError(`Unexpected token in JSON: ${CANARY}`) } },
      log: (e: Record<string, unknown>) => void logs.push(e),
      runner: 'runner-0',
    } as unknown as EgressDeps
    const res = await handleEgress(egressRequest('/store/append', { body: {} }), deps, NO_CAPTURE)
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).not.toContain(CANARY)
    expect(JSON.parse(body)).toEqual({ error: 'internal' })
    expect(logs).toEqual([{ event: 'egress_failed', error: 'SyntaxError', runner: 'runner-0' }])
  })
})
