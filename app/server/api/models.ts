// The model list (P3, p3-design section 3): route 38, `GET /api/models`. The models a turn may run on now: every
// catalogue model `resolveModel` accepts under the brand's settings (switched off or unpriced ones left out), each with
// its effort as Settings sets it. Shape: models.json's (`{ default, modes: ModelMode[] }`), `default` the catalogue's
// default when it's on, else the first one on, else null.
import { ModelModeSchema } from '../../shared/contract/model.ts'
import type { ModelMode } from '../../shared/contract/model.ts'
import { storesOf } from '../db/handler-kit.ts'
import { BRAND_OWNER } from '../db/settings.ts'
import { apiError, apiJson } from '../http.ts'
import { CATALOG, resolveModel } from '../model/catalog.ts'
import type { SettingsView } from '../model/catalog.ts'
import type { Handler } from '../routes.ts'

/** The picker's default (the client's models.json `default`). */
export const DEFAULT_MODEL_ID = 'opus'

/** Route 38, `GET /api/models`. W3. */
export const listModels: Handler = async c => {
  if (new URL(c.request.url).search !== '') return apiError('invalid')
  const settings: Record<string, string | boolean | null> = {}
  for (const r of await storesOf(c).settings.list(BRAND_OWNER, 'technical')) {
    if (typeof r.value === 'string' || typeof r.value === 'boolean' || r.value === null) settings[r.key] = r.value
  }
  const view: SettingsView = settings
  const modes: ModelMode[] = []
  for (const m of CATALOG) {
    const r = resolveModel(m.id, view)
    if ('refused' in r) continue
    modes.push(ModelModeSchema.parse({ id: m.id, label: m.label, model: m.name, sub: m.sub, effort: r.effort }))
  }
  const fallback = modes[0]?.id ?? null
  return apiJson({ default: modes.some(m => m.id === DEFAULT_MODEL_ID) ? DEFAULT_MODEL_ID : fallback, modes })
}
