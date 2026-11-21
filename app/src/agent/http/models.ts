// The model picker and the Models page over HTTP (P3, p3-design sections 3 and 4.9): route 38, `GET /api/models`, lists only
// the models a turn may run on now (switched off or unpriced ones are left out). The Models page must also show a model that
// is switched off, so an Admin can switch it on: it comes from this catalogue, the same four models the server's
// `CATALOG` names (models.test.ts compares the two). Plain code, no zod (the entry's size budget, schemas.ts).
import type { ModelMode } from '../types'
import type { Transport } from './transport'

/** Strongest first: the picker ids, labels, names, lines and default efforts of `server/model/catalog.ts`. */
export const MODEL_CATALOG: readonly ModelMode[] = [
  { id: 'fable', label: 'Max', model: 'Fable 5.2', sub: 'Hardest problems and long jobs · costs most', effort: 'high' },
  { id: 'opus', label: 'Smart', model: 'Opus 5.5', sub: 'Best for most work', effort: 'medium' },
  { id: 'sonnet', label: 'Fast', model: 'Sonnet 5.5', sub: 'Quick answers, still thinks well · half the cost', effort: 'medium' },
  { id: 'haiku', label: 'Instant', model: 'Haiku 5.5', sub: 'Simple lookups and sorting · costs least', effort: 'low' },
]

/** What route 38 says: the models on now (with the effort Settings gives each), and the default when one is on. */
export interface ServedModels { default: string | null; modes: ModelMode[] }

/** Route 38. */
export const readModels = (http: Transport): Promise<ServedModels> => http.call({ method: 'GET', path: '/api/models', schema: 'models' })

/**
 * The models the picker and the Models page list: every one the server serves, and every catalogue model an Admin
 * switched off (`tm:<id>:on` is `off`), so it can be switched on again. A catalogue model that is on but not served
 * (unpriced) isn't listed: it can't run. Strongest first.
 */
export function listedModels(served: ServedModels | null, saved: Readonly<Record<string, string>>): ModelMode[] {
  if (!served) return []
  const byId = new Map(served.modes.map(m => [m.id, m] as const))
  const out = MODEL_CATALOG.flatMap((c): ModelMode[] => {
    const s = byId.get(c.id)
    if (s) return [s]
    return saved[`tm:${c.id}:on`] === 'off' ? [c] : []
  })
  // A model the server serves that this build's catalogue doesn't know goes last.
  for (const m of served.modes) if (!MODEL_CATALOG.some(c => c.id === m.id)) out.push(m)
  return out
}
