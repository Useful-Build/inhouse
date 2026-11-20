// The model catalogue (p3-design 4.9 and 8.2): the models a turn may run on, their API ids, default efforts and prices,
// and `resolveModel`, the one function route 29 (send a turn) and route 38 (the model list) decide a model with.
// W1's first PR writes the ids, labels, efforts and `resolveModel`; W3 fills the prices (from Anthropic's pricing page,
// cited) and owns this file afterwards. A model without a price is refused (`model_off`): fail closed, so a model never
// runs before the spend gate can price its calls.
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
  /** The Messages API model id. */
  apiId: string
  /** The effort used when the brand set none (`tm:<id>:effort`). */
  defaultEffort: Effort
  /** null until W3 prices it: `resolveModel` then refuses the model. */
  price: Price | null
}

/** Strongest first. The picker ids and labels are the ones the client's models.json names. */
export const CATALOG: readonly CatalogModel[] = [
  { id: 'fable', label: 'Max', apiId: 'claude-fable-5-2', defaultEffort: 'high', price: null },
  { id: 'opus', label: 'Smart', apiId: 'claude-opus-5-5', defaultEffort: 'medium', price: null },
  { id: 'sonnet', label: 'Fast', apiId: 'claude-sonnet-5-5', defaultEffort: 'medium', price: null },
  { id: 'haiku', label: 'Instant', apiId: 'claude-haiku-5-5', defaultEffort: 'low', price: null },
]

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
