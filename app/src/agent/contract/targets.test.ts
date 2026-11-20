// CONTRACT_REAL_ORIGIN can't drop on its way to the real targets: vitest.config.ts provides it, targets.ts injects it,
// and realTargetsFor hands it to realTargets(). realTargets() returns [] by design until W4, so this proves the input,
// not the output. (Under serve.ts, as in CI's contract step, the variable is set and the first test sees the real value.)
import { expect, inject, test, vi } from 'vitest'
import type { ContractTarget } from './targets'
import { realOrigin, realTargetsFor } from './targets'

// The test runs in node; this project's types are the browser's, so `process` is reached through globalThis.
const envOrigin = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env.CONTRACT_REAL_ORIGIN

test('the injected value is CONTRACT_REAL_ORIGIN, and targets.ts reads it', () => {
  expect(inject('contractRealOrigin')).toBe(envOrigin ?? '')
  expect(realOrigin).toBe(envOrigin || undefined)
})

test('an origin reaches realTargets() and its targets are used', () => {
  const target = { name: 'real' } as ContractTarget
  const make = vi.fn((_origin: string) => [target])
  expect(realTargetsFor('http://brand.localhost:8787', make)).toEqual([target])
  expect(make).toHaveBeenCalledExactlyOnceWith('http://brand.localhost:8787')
})

test('no origin, no real targets', () => {
  const make = vi.fn((_origin: string) => [] as ContractTarget[])
  expect(realTargetsFor(undefined, make)).toEqual([])
  expect(make).not.toHaveBeenCalled()
})
