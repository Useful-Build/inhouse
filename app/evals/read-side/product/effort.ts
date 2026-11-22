// The run's effort, pinned to medium for every model (Wasim's decision) through the product's own settings API, audited, as
// morning-check/remote.ts ensureDefaultModel writes `g:mode`: the technical setting `tm:<picker>:effort` (settings-table.ts,
// a label from EFFORT_LABELS; server/model/catalog.ts resolveModel reads it for every turn). Only the Inhouse team writes a
// technical setting other than `tm:<id>:on` (server/auth/matrix.ts), so: the Admin ends live grants, opens a one-hour grant,
// the seeded Inhouse team member PUTs the label with the setting's revision, the Admin ends every live grant again whatever the
// PUT did, then the value is read back as the Admin. Anything but the label read back stops the run.
// The previous value is put back at the end and on signals; a key that was never set goes back to the model's catalogue
// default label (the same effort resolveModel uses for a missing key: the API has no way to unset it).
import { CATALOG, EFFORT_BY_LABEL } from '../../../server/model/catalog.ts'
import type { ApiCall } from '../../morning-check/remote.ts'

export interface SettingsApi { admin: ApiCall; inhouse: ApiCall }

/** The label the run pins: Medium (args.ts EFFORT). */
export const EFFORT_LABEL = 'Medium'
const LABELS = Object.keys(EFFORT_BY_LABEL)

const said = (what: string, r: { status: number; json: unknown }) => new Error(`read-side: ${what} answered ${r.status}`)

/** The setting's key for an API model id. */
export function effortKey(apiId: string): string {
  const m = CATALOG.find((x) => x.apiId === apiId)
  if (!m) throw new Error(`read-side: ${apiId} is not in the catalogue`)
  return `tm:${m.id}:effort`
}

/** The catalogue default effort's label for an API model id. */
export function defaultLabel(apiId: string): string {
  const m = CATALOG.find((x) => x.apiId === apiId)!
  return Object.entries(EFFORT_BY_LABEL).find(([, e]) => e === m.defaultEffort)![0]
}

async function readSetting(api: SettingsApi, key: string): Promise<{ value: unknown; rev: number }> {
  const r = await api.admin('GET', '/api/settings/technical')
  if (r.status !== 200) throw said('GET /api/settings/technical', r)
  const items = (r.json as { items?: { key: string; value?: unknown; rev?: number }[] } | null)?.items
  if (!Array.isArray(items)) throw new Error('read-side: GET /api/settings/technical has no items')
  const row = items.find((i) => i.key === key)
  return { value: row?.value, rev: row?.rev ?? 0 }
}

async function endLiveGrants(admin: ApiCall): Promise<string[]> {
  const list = await admin('GET', '/api/grants')
  if (list.status !== 200) return [`GET /api/grants answered ${list.status}`]
  const items = (list.json as { items?: { id: string; rev: number; live: boolean }[] } | null)?.items
  if (!Array.isArray(items)) return ['GET /api/grants has no items']
  const errors: string[] = []
  for (const g of items.filter((x) => x.live)) {
    const done = await admin('POST', `/api/grants/${encodeURIComponent(g.id)}/end`, { ifRev: g.rev })
    if (done.status !== 200) errors.push(`ending support grant ${g.id} answered ${done.status}`)
  }
  return errors
}

/** Writes `label` to `key` (when it differs) and reads it back; throws on any refusal or a different value. */
export async function writeEffort(api: SettingsApi, key: string, label: string): Promise<void> {
  if (!LABELS.includes(label)) throw new Error(`read-side: ${JSON.stringify(label)} is not an effort label`)
  const now = await readSetting(api, key)
  if (now.value !== label) {
    const before = await endLiveGrants(api.admin)
    if (before.length) throw new Error(`read-side: live support grants could not be ended: ${before.join('; ')}`)
    let failed: unknown = null
    try {
      const grant = await api.admin('POST', '/api/grants', { hours: 1 })
      if (grant.status !== 201) throw said('opening a support grant', grant)
      const put = await api.inhouse('PUT', `/api/settings/technical/${encodeURIComponent(key)}`, { value: label, ifRev: now.rev })
      if (put.status !== 200) throw said(`setting ${key} to ${label}`, put)
    } catch (e) {
      failed = e
    }
    const after = await endLiveGrants(api.admin)
    if (failed !== null) throw new Error(`${failed instanceof Error ? failed.message : String(failed)}${after.length ? `; and live support grants could not be ended: ${after.join('; ')}` : ''}`)
    if (after.length) throw new Error(`read-side: live support grants could not be ended: ${after.join('; ')}`)
  }
  const back = await readSetting(api, key)
  if (back.value !== label) throw new Error(`read-side: ${key} reads back ${JSON.stringify(back.value)}, not ${label}: refusing to run on another effort`)
}

/**
 * Pins the model's effort to Medium and returns how to put it back (idempotent: the second call does nothing). The value put
 * back is the one read before the write, or the catalogue default label when the key was never set.
 */
export async function pinEffort(api: SettingsApi, apiId: string): Promise<() => Promise<void>> {
  const key = effortKey(apiId)
  const was = (await readSetting(api, key)).value
  const restoreTo = typeof was === 'string' && LABELS.includes(was) ? was : defaultLabel(apiId)
  let restored = false
  const restore = async () => {
    if (restored) return
    restored = true
    await writeEffort(api, key, restoreTo)
  }
  try {
    await writeEffort(api, key, EFFORT_LABEL)
  } catch (e) {
    // A half-made write is put back before the refusal leaves; a failed put-back is said with it.
    try {
      await restore()
    } catch (r) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}; and putting ${key} back to ${restoreTo} failed: ${r instanceof Error ? r.message : String(r)}`, { cause: e })
    }
    throw e
  }
  return restore
}
