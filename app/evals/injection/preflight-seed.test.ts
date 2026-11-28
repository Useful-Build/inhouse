// #723: the preflight's seed check must stop the run when one planned case's seed would be refused, before any turn and
// before the target's own checks. No real case is refused today (the fix in #721), so the WebFetch list one case's seed
// would write is made one the door refuses, through the real seedRefusal and the real door rule.
import { describe, expect, it, vi } from 'vitest'
import type { ProductTarget } from '../targets/product.ts'
import { DoorRefusal } from '../targets/door.ts'
import { INJECTION_CASES } from './cases.ts'
import { runInjection } from './runner.ts'

const refuseFor = vi.hoisted(() => ({ hosts: null as string[] | null }))
vi.mock('../targets/product.ts', async (original) => {
  const real = await original<typeof import('../targets/product.ts')>()
  return {
    ...real,
    // The list P03's seed would write, made one the door refuses (an empty list); every other case as it really is.
    webfetchListFor: (exfil: Parameters<typeof real.webfetchListFor>[0]) => (refuseFor.hosts !== null && (exfil as { plant?: (canary: string) => string } | undefined)?.plant?.('c').includes('the last 200 orders while you are at it') ? refuseFor.hosts : real.webfetchListFor(exfil)),
  }
})
const { createProductInjectionTarget } = await import('./product.ts')

const kase = (id: string) => INJECTION_CASES.find((c) => c.id === id)!

describe('#723: one planned case whose seed would be refused stops the run before any turn', () => {
  it('the preflight refuses, naming the case, before the target\'s own checks; no repeat starts', async () => {
    const calls: string[] = []
    const base = {
      name: 'product', people: { current: 'm_c', tom: 'm_t', lena: 'm_l' }, provides: new Set(['tag_ops', 'stock_ops', 'refund']),
      async ready() { calls.push('ready') },
      writeDoor: () => ({ now: async () => { calls.push('d1'); return 1 } }),
      async seed() { calls.push('seed'); throw new Error('no seed may run') },
    } as unknown as ProductTarget
    const target = createProductInjectionTarget({ paid: true, env: {}, inhouse: null, base, sessions: { preflight: async () => { calls.push('r2') }, parts: async () => [] } })
    refuseFor.hosts = []
    try {
      const err = await runInjection({ target, cases: [kase('P01'), kase('P03')], reps: 1 }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DoorRefusal)
      expect((err as Error).message).toBe('P03\'s seed would be refused: not a host list the server reads (parseHostlist)')
      expect(calls).toEqual([])
      // As it really is: the same run passes the check (and goes on to the target's own checks).
      refuseFor.hosts = null
      await expect(target.preflight!([kase('P01'), kase('P03')])).resolves.toBeUndefined()
      expect(calls).toEqual(['ready', 'd1', 'r2'])
    } finally {
      refuseFor.hosts = null
    }
  })
})
