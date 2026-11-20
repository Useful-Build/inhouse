// Pricing a model call (p3-design 8.2 and 8.3): its worst case before admission and its bill from the usage tally, both
// in micro-USD from the catalogue's card. Rates are micro-USD per million tokens, so a cost is Σ tokens × rate / 10^6,
// rounded up once at the end. Multipliers (fast mode, geo) apply to every token category, never to the search fee
// (pricing page, read 2026-11-20: the geo multiplier applies to "all token pricing categories, including input tokens,
// output tokens, cache writes, and cache reads"; fast mode is a premium on token rates; search is "$10 USD per 1,000
// searches"). BigInt keeps the products exact.
import type { Price, PriceTier } from './catalog.ts'

/** What changes a call's price beyond its token counts. */
export interface PriceModifiers {
  fast: boolean
  /** The request's `inference_geo`, or null when it sent none. */
  geo: string | null
}

/** A call's usage, each field as the last cumulative value the response carried (8.3). */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  cacheReadTokens: number
  webSearches: number
}

/** The tier a call's prompt falls in: input + cache reads + cache writes, as the pricing page counts a prompt. */
export function tierFor(price: Price, promptTokens: number): PriceTier {
  const tier = price.tiers.find(t => t.uptoInputTokens === null || promptTokens <= t.uptoInputTokens)
  if (!tier) throw new Error('price card has no tier for this prompt')
  return tier
}

/** The multipliers in thousandths, or null when the card refuses the modifier (fast mode off, an unlisted geo). */
export function multipliersOf(price: Price, m: PriceModifiers): { fast: bigint; geo: bigint } | null {
  let fast = 1000n
  if (m.fast) {
    if (price.fastModeMultiplier === null) return null
    fast = BigInt(Math.round(price.fastModeMultiplier * 1000))
  }
  let geo = 1000n
  if (m.geo !== null) {
    if (!Object.hasOwn(price.geoMultipliers, m.geo)) return null
    geo = BigInt(Math.round(price.geoMultipliers[m.geo]! * 1000))
  }
  return { fast, geo }
}

/** ceil(tokenProduct × fast × geo / (10^6 × 10^3 × 10^3)) + searches × fee. */
function total(tokenProduct: bigint, mult: { fast: bigint; geo: bigint }, searches: number, perSearch: number): number {
  const num = tokenProduct * mult.fast * mult.geo
  const den = 1_000_000n * 1_000n * 1_000n
  return Number((num + den - 1n) / den) + searches * perSearch
}

const b = (n: number) => BigInt(n)

/** A call's bill from its usage. Throws when the card refuses a modifier (admission refuses those first). */
export function priceUsage(price: Price, m: PriceModifiers, u: TokenUsage): number {
  const mult = multipliersOf(price, m)
  if (!mult) throw new Error('priceUsage: a modifier the card has no price for')
  const tier = tierFor(price, u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens)
  const product = b(u.inputTokens) * b(tier.input) + b(u.outputTokens) * b(tier.output) + b(u.cacheWrite5mTokens) * b(tier.cacheWrite5m)
    + b(u.cacheWrite1hTokens) * b(tier.cacheWrite1h) + b(u.cacheReadTokens) * b(tier.cacheRead)
  return total(product, mult, u.webSearches, price.webSearchPerUse)
}

/** The input-side rate a worst case uses: the highest the request can incur (8.2 step 4). */
export type InputRate = 'input' | 'cacheWrite5m' | 'cacheWrite1h'

/**
 * A call's worst case (8.2 step 4): `inputTokens` (search allowance included) at `rate` in the tier they fall in, plus
 * `maxTokens` of output, plus `searchUses` searches. Covers any usage with prompt ≤ inputTokens, output ≤ maxTokens and
 * searches ≤ searchUses, since the tier only rises with the prompt and the chosen rate is the highest the request can
 * incur.
 */
export function priceWorst(price: Price, m: PriceModifiers, w: { inputTokens: number; rate: InputRate; maxTokens: number; searchUses: number }): number {
  const mult = multipliersOf(price, m)
  if (!mult) throw new Error('priceWorst: a modifier the card has no price for')
  const tier = tierFor(price, w.inputTokens)
  const inputRate = Math.max(tier.input, w.rate === 'input' ? 0 : tier[w.rate])
  return total(b(w.inputTokens) * b(inputRate) + b(w.maxTokens) * b(tier.output), mult, w.searchUses, price.webSearchPerUse)
}
