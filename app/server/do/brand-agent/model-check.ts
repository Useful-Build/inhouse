// The start's model check (A3, from #153's review): is the turn's model (its picker id) still on and priced in the
// brand's technical settings? The same rule route 29 applies (`resolveModel`), read again from D1 when the turn starts.
import { BRAND_OWNER } from '../../db/settings.ts'
import type { Stores } from '../../db/stores.ts'
import { resolveModel } from '../../model/catalog.ts'
import type { SettingsView } from '../../model/catalog.ts'

export function modelUsable(stores: Pick<Stores, 'settings'>): (pickerId: string) => Promise<boolean> {
  return async pickerId => {
    const settings: Record<string, string | boolean | null> = {}
    for (const s of await stores.settings.list(BRAND_OWNER, 'technical')) settings[s.key] = s.value as string | boolean | null
    return !('refused' in resolveModel(pickerId, settings as SettingsView))
  }
}
