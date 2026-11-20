// Pricing and the tally (p3-design 8.2, 8.3, 9). Every expected amount is written by hand from the pricing page's rates
// (read 2026-11-20), never taken from the code. Ways it can fail, written down first:
//  1. cumulative stream usage is summed instead of taking each field's last value;
//  2. the wrong tier: Haiku 5.5 over 100,000 prompt tokens (input + cache reads + writes) not repriced, output included;
//  3. 1-hour cache writes priced as 5-minute ones, or a modifier (fast mode, geo) lost or applied to the search fee;
//  4. a worst case below the bill it reserves for (except search results beyond the allowance, made up later);
//  5. the per-turn ceilings drift from the item 22 E2 table, or the shipped catalogue prices fast mode or `us`.
import { describe, expect, it } from 'vitest'
import { CATALOG, TURN_CEILING_MICRO } from './catalog.ts'
import type { Price } from './catalog.ts'
import { priceUsage, priceWorst } from './pricing.ts'
import type { TokenUsage } from './pricing.ts'
import { createSseTally, usageOfMessage } from './tally.ts'

const card = (apiId: string) => CATALOG.find(m => m.apiId === apiId)!.price!
const SONNET = card('claude-sonnet-5-5')
const OPUS = card('claude-opus-5-5')
const HAIKU = card('claude-haiku-5-5')
/** A test-only Opus 5.5 card that offers fast mode (2x, $8/$40) and `us` (1.1x), as the pricing page lists them. */
const OPUS_MODIFIED: Price = { ...OPUS, fastModeMultiplier: 2, geoMultipliers: { global: 1, us: 1.1 } }
const STANDARD = { fast: false, geo: null }
const zero: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, webSearches: 0 }
const sse = (events: object[]) => events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const tallyOf = (text: string, splitAt: number[] = []) => {
  const t = createSseTally()
  const bytes = new TextEncoder().encode(text)
  let from = 0
  for (const at of [...splitAt, bytes.length]) {
    t.push(bytes.subarray(from, at))
    from = at
  }
  return t
}

describe('literal priced vectors (failures 1-3)', () => {
  it('a JSON response: Sonnet 5.5, 1,000 in and 500 out = $0.002 + $0.005', () => {
    const u = usageOfMessage({ type: 'message', usage: { input_tokens: 1000, output_tokens: 500 } })!
    expect(priceUsage(SONNET, STANDARD, u)).toBe(7_000)
  })

  it('an SSE stream with three cumulative message_deltas takes the last value of each field', () => {
    const text = sse([
      { type: 'message_start', message: { usage: { input_tokens: 2000, cache_read_input_tokens: 10000, output_tokens: 1 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 50 } },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 120 } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 2000, output_tokens: 300 } },
      { type: 'message_stop' },
    ])
    // Split inside an event and inside a multi-byte-free JSON line: the parser must buffer.
    const t = tallyOf(text, [17, 140, 141, 400])
    expect(t.complete).toBe(true)
    expect(t.usage()).toEqual({ ...zero, inputTokens: 2000, cacheReadTokens: 10000, outputTokens: 300 })
    // Opus 5.5: 2,000 × $4 + 10,000 × $0.20 + 300 × $20 per MTok = $0.008 + $0.002 + $0.006.
    expect(priceUsage(OPUS, STANDARD, t.usage())).toBe(16_000)
  })

  it('a stream with no message_stop is not complete (the cut-stream rule prices it at its worst case)', () => {
    const t = tallyOf(sse([{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }, { type: 'message_delta', usage: { output_tokens: 9 } }]))
    expect(t.complete).toBe(false)
  })

  it('1-hour cache writes at the 1-hour rate: Sonnet 5.5, 50,000 written for 1 h', () => {
    const u = usageOfMessage({ usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 50000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50000 } } })!
    // 100 × $2 + 50,000 × $4 + 200 × $10 per MTok.
    expect(priceUsage(SONNET, STANDARD, u)).toBe(202_200)
  })

  it('cache writes with no split are priced at the 1-hour rate (never under-priced)', () => {
    const u = usageOfMessage({ usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 } })!
    expect(priceUsage(SONNET, STANDARD, u)).toBe(4_000)
  })

  it('a web search call: two searches at $10 per 1,000 on top of the tokens', () => {
    const u = usageOfMessage({ usage: { input_tokens: 12000, output_tokens: 800, server_tool_use: { web_search_requests: 2 } } })!
    // 12,000 × $2 + 800 × $10 per MTok + 2 × $0.01.
    expect(priceUsage(SONNET, STANDARD, u)).toBe(52_000)
  })

  it('a fast-mode call at the fast card ($8 / $40 on Opus 5.5)', () => {
    expect(priceUsage(OPUS_MODIFIED, { fast: true, geo: null }, { ...zero, inputTokens: 1000, outputTokens: 1000 })).toBe(48_000)
  })

  it('an inference_geo "us" call at 1.1x every token category, the search fee not multiplied', () => {
    expect(priceUsage(OPUS_MODIFIED, { fast: false, geo: 'us' }, { ...zero, inputTokens: 1000, outputTokens: 1000 })).toBe(26_400)
    expect(priceUsage(OPUS_MODIFIED, { fast: false, geo: 'us' }, { ...zero, inputTokens: 1000, outputTokens: 1000, webSearches: 1 })).toBe(36_400)
  })

  it('Haiku 5.5 just over the 100,000-token tier: the whole request on the higher card', () => {
    // At 100,000 (90,000 in + 10,000 cache reads): 90,000 × $0.10 + 10,000 × $0.01 + 1,000 × $0.50 per MTok.
    expect(priceUsage(HAIKU, STANDARD, { ...zero, inputTokens: 90000, cacheReadTokens: 10000, outputTokens: 1000 })).toBe(9_600)
    // At 100,001: 90,000 × $0.50 + 10,001 × $0.05 + 1,000 × $2.50 = $0.04800005, rounded up.
    expect(priceUsage(HAIKU, STANDARD, { ...zero, inputTokens: 90000, cacheReadTokens: 10001, outputTokens: 1000 })).toBe(48_001)
  })

  it('the shipped catalogue refuses fast mode and inference_geo "us" (design 9, CHOICE)', () => {
    for (const m of CATALOG) {
      expect(() => priceUsage(m.price!, { fast: true, geo: null }, zero), m.id).toThrow()
      expect(() => priceUsage(m.price!, { fast: false, geo: 'us' }, zero), m.id).toThrow()
      expect(priceUsage(m.price!, { fast: false, geo: 'global' }, zero), m.id).toBe(0)
    }
  })
})

describe('the worst case covers the bill (failure 4)', () => {
  // Each vector's request as the gate prices it: prompt bound, rate, max_tokens and search uses that admit the usage.
  const cases: { name: string; price: Price; mods: { fast: boolean; geo: string | null }; worst: Parameters<typeof priceWorst>[2]; usage: TokenUsage }[] = [
    { name: 'JSON', price: SONNET, mods: STANDARD, worst: { inputTokens: 1000, rate: 'input', maxTokens: 500, searchUses: 0 }, usage: { ...zero, inputTokens: 1000, outputTokens: 500 } },
    { name: 'SSE', price: OPUS, mods: STANDARD, worst: { inputTokens: 12000, rate: 'cacheWrite5m', maxTokens: 300, searchUses: 0 }, usage: { ...zero, inputTokens: 2000, cacheReadTokens: 10000, outputTokens: 300 } },
    { name: '1h write', price: SONNET, mods: STANDARD, worst: { inputTokens: 50100, rate: 'cacheWrite1h', maxTokens: 200, searchUses: 0 }, usage: { ...zero, inputTokens: 100, cacheWrite1hTokens: 50000, outputTokens: 200 } },
    { name: 'search', price: SONNET, mods: STANDARD, worst: { inputTokens: 12000, rate: 'input', maxTokens: 800, searchUses: 2 }, usage: { ...zero, inputTokens: 12000, outputTokens: 800, webSearches: 2 } },
    { name: 'fast', price: OPUS_MODIFIED, mods: { fast: true, geo: null }, worst: { inputTokens: 1000, rate: 'input', maxTokens: 1000, searchUses: 0 }, usage: { ...zero, inputTokens: 1000, outputTokens: 1000 } },
    { name: 'us', price: OPUS_MODIFIED, mods: { fast: false, geo: 'us' }, worst: { inputTokens: 1000, rate: 'input', maxTokens: 1000, searchUses: 0 }, usage: { ...zero, inputTokens: 1000, outputTokens: 1000 } },
    { name: 'tier', price: HAIKU, mods: STANDARD, worst: { inputTokens: 100001, rate: 'input', maxTokens: 1000, searchUses: 0 }, usage: { ...zero, inputTokens: 90000, cacheReadTokens: 10001, outputTokens: 1000 } },
  ]
  for (const c of cases) {
    it(`${c.name}: worst ≥ bill`, () => {
      expect(priceWorst(c.price, c.mods, c.worst)).toBeGreaterThanOrEqual(priceUsage(c.price, c.mods, c.usage))
    })
  }

  it('search results past the allowance can pass the worst case (the next admission covers it)', () => {
    // One search allowed: the gate adds 10,000 input tokens for it on a 2,000-token prompt. Its results were 30,000.
    const worst = priceWorst(SONNET, STANDARD, { inputTokens: 2000 + 10000, rate: 'input', maxTokens: 100, searchUses: 1 })
    const bill = priceUsage(SONNET, STANDARD, { ...zero, inputTokens: 32000, outputTokens: 100, webSearches: 1 })
    expect(worst).toBe(35_000)
    expect(bill).toBe(75_000)
  })
})

describe('the per-turn ceilings (failure 5)', () => {
  // Rates per MTok, from the pricing page (read 2026-11-20): 1-hour cache write and output; Haiku on its >100K card.
  const rates: Record<string, [number, number]> = {
    'claude-fable-5-2': [16, 40], 'claude-opus-5-5': [8, 20], 'claude-sonnet-5-5': [4, 10], 'claude-haiku-5-5': [1, 2.5],
  }
  it('each is 4 × (700,000 at the 1-hour write rate + 32,000 output + 5 searches) + $2.00, as the table says', () => {
    for (const [model, [write1h, output]] of Object.entries(rates)) {
      const single = Math.round(700_000 * write1h + 32_000 * output) + 5 * 10_000
      expect(TURN_CEILING_MICRO[model], model).toBe(4 * single + 2_000_000)
    }
    expect(TURN_CEILING_MICRO).toEqual({ 'claude-fable-5-2': 52_120_000, 'claude-opus-5-5': 27_160_000, 'claude-sonnet-5-5': 14_680_000, 'claude-haiku-5-5': 5_320_000 })
  })
  it("the gate's own worst case at the input bound matches the single-call figure", () => {
    const at = (apiId: string) => priceWorst(card(apiId), STANDARD, { inputTokens: 700_000, rate: 'cacheWrite1h', maxTokens: 32_000, searchUses: 5 })
    expect([at('claude-fable-5-2'), at('claude-opus-5-5'), at('claude-sonnet-5-5'), at('claude-haiku-5-5')]).toEqual([12_530_000, 6_290_000, 3_170_000, 830_000])
  })
})
