// House release markers, from a file the driver is given (`--releases <file>`). House releases run from the private ops
// repo (house-release.yml, the app's main SHA), and so does this driver. The orchestrator appends a marker at each house
// release; the ops automation that appends them comes later. The file is a JSON array of
//   { "at": "<ISO UTC>", "app_sha": "<40 hex>", "live": ["P4", "P5", ...], "behaviour": true | false }
// and is read strictly: anything it shouldn't say throws a `ReleasesError`, and the driver exits 2 on it. A missing
// `behaviour` counts as true (an unmarked release restarts the window rather than hiding one). `live` is the full set of
// phases live after that release, not an addition to the one before.
import type { ReleaseMarker } from './types.ts'

export class ReleasesError extends Error {}

/** The phase names a marker's `live` may hold. */
export const KNOWN_PHASES: ReadonlySet<string> = new Set(['P3', 'P4', 'P5', 'P6a', 'P6b', 'P7', 'P8a', 'P8b'])

const KEYS = new Set(['at', 'app_sha', 'live', 'behaviour'])
const SHA = /^[0-9a-f]{40}$/
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

function parseAt(v: unknown, where: string): number {
  const m = typeof v === 'string' ? ISO_UTC.exec(v) : null
  if (!m) throw new ReleasesError(`${where}: "at" must be an ISO UTC time like 2026-12-01T06:00:00Z`)
  const [, y, mo, d, h, mi, s, ms] = m
  const ts = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms ? Number(ms.padEnd(3, '0')) : 0)
  const back = new Date(ts)
  if (back.getUTCFullYear() !== Number(y) || back.getUTCMonth() !== Number(mo) - 1 || back.getUTCDate() !== Number(d) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
    throw new ReleasesError(`${where}: "at" is not a real time`)
  }
  return ts
}

/** The markers in the file's text, oldest first. */
export function parseReleases(text: string): ReleaseMarker[] {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new ReleasesError('the releases file is not JSON') }
  if (!Array.isArray(raw)) throw new ReleasesError('the releases file must be a JSON array')
  const out: ReleaseMarker[] = []
  raw.forEach((entry, i) => {
    const where = `release ${i}`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new ReleasesError(`${where}: not an object`)
    const e = entry as Record<string, unknown>
    for (const k of Object.keys(e)) if (!KEYS.has(k)) throw new ReleasesError(`${where}: unknown key "${k}"`)
    const atMs = parseAt(e.at, where)
    if (typeof e.app_sha !== 'string' || !SHA.test(e.app_sha)) throw new ReleasesError(`${where}: "app_sha" must be 40 lowercase hex characters`)
    if (!Array.isArray(e.live) || e.live.some(p => typeof p !== 'string')) throw new ReleasesError(`${where}: "live" must be a list of phase names`)
    const live = e.live as string[]
    for (const p of live) if (!KNOWN_PHASES.has(p)) throw new ReleasesError(`${where}: unknown phase "${p}"`)
    if (new Set(live).size !== live.length) throw new ReleasesError(`${where}: "live" repeats a phase`)
    if (e.behaviour !== undefined && typeof e.behaviour !== 'boolean') throw new ReleasesError(`${where}: "behaviour" must be true or false`)
    if (out.some(m => m.atMs === atMs)) throw new ReleasesError(`${where}: another release has the same "at"`)
    out.push({ atMs, appSha: e.app_sha, live, behaviour: e.behaviour !== false })
  })
  return out.sort((a, b) => a.atMs - b.atMs)
}
