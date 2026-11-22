// The hub's one logger (index/log.ts) keeps its allowlist (P8a P-auth): a caught error's message, stack or the error
// itself passed under a field name it doesn't list never reaches a log line, even past the type check.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { log, type LogFields } from './log'

const CANARY = 'CANARY-customer-email-7f3a'

afterEach(() => vi.restoreAllMocks())

describe('log', () => {
  it('drops an error, message or stack field holding the canary, and keeps the allowlisted ones', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = new Error(CANARY)
    log('hub_internal', { code: 'internal', error: err, message: err.message, stack: err.stack } as unknown as LogFields)
    expect(out).toHaveBeenCalledTimes(1)
    const line = out.mock.calls[0]![0] as string
    expect(line).not.toContain(CANARY)
    expect(JSON.parse(line)).toEqual({ event: 'hub_internal', code: 'internal' })
  })
})
