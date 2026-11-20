// The per-turn ceilings (p3-design section 9, Wasim's item 22 E2, 2026-11-20, superseding E1): 4 × the model's single-call
// worst case at the input bound + $2.00, in micro-USD, by Messages API model id. The arithmetic is in the design's
// table; the numbers here are its results, copied, never computed from the price card (the egress prices calls, this
// only bounds a turn). The BrandAgent's `maxBudgetUsd` is the same number in dollars.
// CHOICE (W4): the design names `catalog.ts` for this constant; that file is W3's, so the table lives here and
// ceilings.test.ts pins it to the catalogue's ids. Moving it is a one-line import change.

export const TURN_CEILING_MICRO: Readonly<Record<string, number>> = {
  'claude-fable-5-2': 52_120_000,
  'claude-opus-5-5': 27_160_000,
  'claude-sonnet-5-5': 14_680_000,
  'claude-haiku-5-5': 5_320_000,
}

/** The model's ceiling; throws for a model with none (route 29 only lets catalogue models through). */
export function turnCeilingMicro(model: string): number {
  const c = TURN_CEILING_MICRO[model]
  if (c === undefined) throw new Error(`usage: no per-turn ceiling for model ${model}`)
  return c
}
