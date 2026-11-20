// The model catalogue (p3-design 4.9 and 8.2): the models a turn may run on, their API ids, default efforts and prices,
// and `resolveModel`, the one function route 29 (send a turn) and route 38 (the model list) decide a model with.
// W1's first PR writes the ids, labels, efforts and `resolveModel`; W3 fills the prices and owns this file afterwards. A
// model without a price is refused (`model_off`): fail closed, so a model never runs before the spend gate can price
// its calls.
//
// Prices: https://platform.claude.com/docs/en/about-claude/pricing (read 2026-11-20). Fable 5.2, Opus 5.5 and Sonnet 5.5
// have no long-context premium ("include the full 1M token context window at standard pricing"). Haiku 5.5 "is priced
// by prompt length: a request whose prompt is over 100,000 tokens pays higher prices. A request's prompt length counts
// all of its input tokens, including cache reads and cache writes", and the higher card covers output too. Web search
// "$10 USD per 1,000 searches". Fast mode (2x on Fable 5.2 and Opus 5.5) and `inference_geo: "us"` (1.1x) are priced
// on that page but not offered here (p3-design 9, CHOICE: refused, so no multiplier enters a worst case); `global` is
// the standard price ("`inference_geo: \"global\"` (default) uses standard pricing").
import type { Effort } from '../../shared/contract/common.ts'
import type { ErrorReason } from '../../shared/contract/common.ts'
import { EFFORT_LABELS } from '../../shared/contract/settings-table.ts'

/** One input-token tier of a model's price card (8.3). Rates in micro-USD per million tokens. */
export interface PriceTier {
  /** The tier applies to calls whose total input (input + cache reads + cache writes) is at most this; null: no bound. */
  uptoInputTokens: number | null
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

/** A model's price card (8.3). W3 fills these. */
export interface Price {
  tiers: readonly PriceTier[]
  /** null: fast mode is refused for this model. */
  fastModeMultiplier: number | null
  /** `inference_geo` values priced for this model; a geo not listed is refused. */
  geoMultipliers: Readonly<Record<string, number>>
  /** Micro-USD per web search use. */
  webSearchPerUse: number
}

export interface CatalogModel {
  /** The picker's id, as in the `tm:<id>:effort` and `tm:<id>:on` settings keys. */
  id: string
  /** The picker's label. */
  label: string
  /** The model's name and the picker's line under it (route 38; the client's models.json). */
  name: string
  sub: string
  /** The Messages API model id. */
  apiId: string
  /** The effort used when the brand set none (`tm:<id>:effort`). */
  defaultEffort: Effort
  /** null until W3 prices it: `resolveModel` then refuses the model. */
  price: Price | null
}

/** Micro-USD per million tokens from US dollars per million tokens. */
function usd(perMTok: number): number {
  return Math.round(perMTok * 1_000_000)
}

/** No fast mode, standard geo only, $10 per 1,000 searches. */
const NO_MODIFIERS = { fastModeMultiplier: null, geoMultipliers: { global: 1 }, webSearchPerUse: 10_000 } as const

/** A one-tier card (no long-context premium). */
function card(input: number, output: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number): Price {
  return { tiers: [{ uptoInputTokens: null, input, output, cacheWrite5m, cacheWrite1h, cacheRead }], ...NO_MODIFIERS }
}

/** Strongest first. The picker ids and labels are the ones the client's models.json names. */
export const CATALOG: readonly CatalogModel[] = [
  { id: 'fable', label: 'Max', name: 'Fable 5.2', sub: 'Hardest problems and long jobs · costs most', apiId: 'claude-fable-5-2', defaultEffort: 'high', price: card(usd(8), usd(40), usd(10), usd(16), usd(0.2)) },
  { id: 'opus', label: 'Smart', name: 'Opus 5.5', sub: 'Best for most work', apiId: 'claude-opus-5-5', defaultEffort: 'medium', price: card(usd(4), usd(20), usd(5), usd(8), usd(0.2)) },
  { id: 'sonnet', label: 'Fast', name: 'Sonnet 5.5', sub: 'Quick answers, still thinks well · half the cost', apiId: 'claude-sonnet-5-5', defaultEffort: 'medium', price: card(usd(2), usd(10), usd(2.5), usd(4), usd(0.1)) },
  {
    id: 'haiku', label: 'Instant', name: 'Haiku 5.5', sub: 'Simple lookups and sorting · costs least', apiId: 'claude-haiku-5-5', defaultEffort: 'low',
    price: {
      tiers: [
        { uptoInputTokens: 100_000, input: usd(0.1), output: usd(0.5), cacheWrite5m: usd(0.125), cacheWrite1h: usd(0.2), cacheRead: usd(0.01) },
        { uptoInputTokens: null, input: usd(0.5), output: usd(2.5), cacheWrite5m: usd(0.625), cacheWrite1h: usd(1), cacheRead: usd(0.05) },
      ],
      ...NO_MODIFIERS,
    },
  },
]

/**
 * The per-turn ceilings (`:turnCeiling`, p3-design 9; Wasim, item 22 E2, 2026-11-20), in micro-USD, by API id: 4 x the
 * model's single-call worst case at the input bound (700,000 tokens at the 1-hour cache-write rate, 32,000 output
 * tokens, 5 searches) + $2.00. One constant table; ceilings.test.ts recomputes each from literal rates.
 */
export const TURN_CEILING_MICRO: Readonly<Record<string, number>> = {
  'claude-fable-5-2': 52_120_000,
  'claude-opus-5-5': 27_160_000,
  'claude-sonnet-5-5': 14_680_000,
  'claude-haiku-5-5': 5_320_000,
}

/** The model the engine's background calls use when it's on and priced; otherwise they use the turn's model. */
const SIDE_MODEL_ID = 'haiku'

/** The Settings page's effort labels (settings-table.ts `EFFORT_LABELS`) to the engine's efforts, in the same order. */
export const EFFORT_BY_LABEL: Readonly<Record<(typeof EFFORT_LABELS)[number], Effort>> = {
  Low: 'low', Medium: 'medium', High: 'high', 'Extra high': 'xhigh', Highest: 'max',
}

/** The brand's technical settings, as stored: key to value (a missing key was never set). */
export type SettingsView = Readonly<Record<string, string | boolean | null | undefined>>

export interface ResolvedModel {
  model: CatalogModel
  effort: Effort
  /** The API id the engine's background calls use (the Haiku entry if it's on and priced, else the turn's model). */
  sideApiId: string
}

export type ModelRefusal = { code: 'invalid' } | { code: 'forbidden'; reason: Extract<ErrorReason, 'model_off'> }

/** Switched off only when `tm:<id>:on` is exactly `'off'`; a missing key or `'on'` is on (as derive.ts reads it). */
const isOn = (id: string, settings: SettingsView) => settings[`tm:${id}:on`] !== 'off'
const usable = (m: CatalogModel, settings: SettingsView) => isOn(m.id, settings) && m.price !== null

/**
 * The model a turn runs on, from the picker's id and the brand's settings: unknown → `invalid`; switched off or
 * unpriced → `forbidden`/`model_off`. The effort is `tm:<id>:effort`'s label, else the catalogue's default.
 * `catalog` is for tests only (a priced copy); every caller uses the default.
 */
export function resolveModel(
  pickerId: string, settings: SettingsView, catalog: readonly CatalogModel[] = CATALOG,
): ResolvedModel | { refused: ModelRefusal } {
  const model = catalog.find(m => m.id === pickerId)
  if (!model) return { refused: { code: 'invalid' } }
  if (!usable(model, settings)) return { refused: { code: 'forbidden', reason: 'model_off' } }
  const label = settings[`tm:${model.id}:effort`]
  const effort = typeof label === 'string' && Object.hasOwn(EFFORT_BY_LABEL, label)
    ? EFFORT_BY_LABEL[label as keyof typeof EFFORT_BY_LABEL]
    : model.defaultEffort
  const side = catalog.find(m => m.id === SIDE_MODEL_ID)
  return { model, effort, sideApiId: side && usable(side, settings) ? side.apiId : model.apiId }
}
