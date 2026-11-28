// What a routine reads from the brand's settings (p4-w2.md sections 3, 4 and 7): the zone (`g:tz`) and the turn
// settings route 29 resolves (seam F, api/runs.ts `resolveTurnSettings`), so a routine's turn runs on the brand's model,
// effort, side model, step cap, WebFetch hosts and web switches like a person's. Not the stage: since M2-F no routine
// waits on it, and M2-I removed its last read here (the technical `stage` setting stays, unread).
import { settingSpec } from '../../shared/contract/settings.ts'
import type { SettingRecord, SettingScope } from '../../shared/contract/settings.ts'
// The two route modules load on first use: statically they would pull the request path's Vite-only imports into
// everything that imports the routine store (the D1 stores, which Node scripts load: scripts/sandbox/seed-remote.mjs).
import type { ResolvedTurn } from '../api/runs.ts'
import { CATALOG, resolveModel } from '../model/catalog.ts'
import type { SettingsView } from '../model/catalog.ts'
import { DEFAULT_TZ } from '../usage/month.ts'

export interface BrandFacts {
  /** The zone, or `invalid` when the stored value isn't a zone this runtime knows (fail loud: the tick decides nothing). */
  tz: string | { invalid: string }
}

const rows = async (db: D1Database) =>
  (await db.prepare("SELECT key, value_json, rev FROM settings WHERE owner = 'brand'").all<{ key: string; value_json: string; rev: number }>()).results

/** The brand's web switches (M1-F): a stored row that doesn't parse turns them off for a routine turn. */
const WEB_SWITCHES = new Set(['t:websearch', 't:webfetch_on'])
/** How far reading web pages reaches (M3-F): a stored row of either that doesn't parse leaves no website for a routine turn (#755). */
const WEB_REACH = new Set(['t:webfetch', 't:webfetch_mode'])

const parse = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

/** Whether the runtime knows the zone (Intl throws `RangeError` for one it doesn't). */
export function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export async function brandFacts(db: D1Database): Promise<BrandFacts> {
  const all = await rows(db)
  const tzRow = all.find(r => r.key === 'g:tz')
  const stored = tzRow ? parse(tzRow.value_json) : null
  // A reset stores null: the default zone. Any other value must be a zone, else the tick stops deciding (signal red).
  const tz = !tzRow || stored === null ? DEFAULT_TZ : typeof stored === 'string' && knownZone(stored) ? stored : { invalid: String(stored) }
  return { tz }
}

/** What a routine's turn is submitted with, besides its text: stored once on the slot (`submit_json`) and re-sent as is. */
export type SubmitSettings = ResolvedTurn

/**
 * The model a routine runs on: the Settings page's default model (`g:mode`, by its label) when it's usable, else the
 * picker's default (`opus`), else the first usable one; then route 29's resolution for the rest. A refusal (every model
 * off) comes back as it is: the tick then decides nothing and the routines signal goes red on the lag.
 */
export async function submitSettings(db: D1Database): Promise<SubmitSettings | { refused: { code: string; reason?: string } }> {
  // The brand and technical rows (the web switches are brand settings, M1-F), each listed under its own scope as the
  // settings store lists them. A web row whose value doesn't parse fails closed, as the egress does (it refuses on the
  // same row): `undefined` would read as never set, which is on for `t:webfetch_on` and any public website for the host
  // list and mode (#755). A switch reads as off; a corrupt mode reads as `false`, which `webFetchMode` takes as `list`;
  // and when either of the two is corrupt the host list reads as `false` too, which `resolveTurnSettings` takes as no
  // host, so neither leaves a website.
  const all = await rows(db)
  const reachBroken = all.some(r => WEB_REACH.has(r.key) && parse(r.value_json) === undefined)
  const valueOf = (key: string, json: string): SettingRecord['value'] => {
    const v = parse(json)
    if (v === undefined && (WEB_SWITCHES.has(key) || key === 't:webfetch_mode')) return false
    return (key === 't:webfetch' && reachBroken ? false : v) as SettingRecord['value']
  }
  const stored = all.map(r => ({ scope: settingSpec(r.key)?.scope, record: { key: r.key, value: valueOf(r.key, r.value_json), rev: r.rev, updatedAt: null, updatedBy: null } }))
  const ofScope = (scope: SettingScope): SettingRecord[] => stored.filter(r => r.scope === scope).map(r => r.record)
  const technical = ofScope('technical')
  const view: SettingsView = Object.fromEntries(technical.map(r => [r.key, r.value as string | boolean | null]))
  const byLabel = CATALOG.find(m => m.label === view['g:mode'])
  const [{ DEFAULT_MODEL_ID }, { resolveTurnSettings }] = await Promise.all([import('../api/models.ts'), import('../api/runs.ts')])
  const choices = [byLabel?.id, DEFAULT_MODEL_ID, ...CATALOG.map(m => m.id)].filter((id): id is string => id !== undefined)
  const pickerId = choices.find(id => !('refused' in resolveModel(id, view))) ?? DEFAULT_MODEL_ID
  const resolved = await resolveTurnSettings({ list: async (_owner, scope) => ofScope(scope) }, pickerId)
  if ('refused' in resolved) return { refused: resolved.refused }
  return resolved
}
