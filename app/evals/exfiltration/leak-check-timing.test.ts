// The fetch leak check's tokenizer (server/egress/taint-tokens.ts, M1-G) in linear time. This runs in Node on purpose: workerd's
// V8 falls back to a linear regex engine on excessive backtracking, so the old quadratic email pattern (12 s on 160 KB
// with no `@`) only shows here, and workerd's clock doesn't move inside synchronous code anyway.
import { describe, expect, it } from 'vitest'
import { extractTokens, extractUrlTokens, resultTokens } from '../../server/egress/taint-tokens.ts'

const ms = (work: () => void): number => {
  const t0 = performance.now()
  work()
  return performance.now() - t0
}

describe('leak check tokenizer timing', () => {
  const noAt = 'a.b_c%d+e-f'.repeat(14_600) // 160 KB of email local-part characters, no `@`
  const letters = 'a'.repeat(160_000)
  const atInMiddle = `${'a'.repeat(80_000)}@${'b'.repeat(80_000)}`
  const manyAt = 'ab.cd@'.repeat(27_000)

  it('scans 160 KB blobs that made the old email pattern quadratic in well under a second each', () => {
    for (const [name, blob] of Object.entries({ noAt, letters, atInMiddle, manyAt })) {
      expect(ms(() => extractTokens(blob)), name).toBeLessThan(500)
      expect(ms(() => resultTokens(JSON.stringify({ result: { content: [{ type: 'text', text: blob }] } }), { route: 'mcp' })), name).toBeLessThan(500)
    }
    expect(ms(() => extractUrlTokens(new URL(`https://docs.example.com/?q=${noAt.slice(0, 16_000)}`)))).toBeLessThan(500)
    expect(extractTokens(`${noAt} alice@example.com`)).toEqual(['alice@example.com'])
  })

  it('grows linearly: 4x the input takes well under 16x the time (median of 5, 5 ms noise floor)', () => {
    const small = 'a.b_c%d+e-f'.repeat(3_700) // 40 KB
    const large = small.repeat(4) // 160 KB: the old pattern took 12 s here
    const median = (s: string) => {
      const runs = Array.from({ length: 5 }, () => ms(() => extractTokens(s))).sort((a, b) => a - b)
      return runs[2]!
    }
    extractTokens(small) // warm up
    expect(median(large)).toBeLessThan(Math.max(median(small), 5) * 10)
  })
})
