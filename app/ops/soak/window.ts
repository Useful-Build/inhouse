// The soak's rules (master plan, "The Watch soak"). A day counts only when every check is present and clean and all
// of P4, P5, P6a and P8a are live. A missing, pending or budget-skipped check is not clean. A bypass or a lost or
// doubled notice restarts the count, and so does a day with a release that changes behaviour (that day mixes two
// builds, so it doesn't count; the next day can). The gate is 3 consecutive clean days.
import { CHECK_NAMES, REQUIRED_PHASES } from './types.ts'
import type { Checks, DayReason, DayRecord, ReleaseMarker } from './types.ts'

export const GATE_DAYS = 3
const DAY_MS = 86_400_000

export const dayStartMs = (day: string): number => {
  const ms = Date.parse(`${day}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(ms)) throw new Error(`not a UTC day: ${day}`)
  return ms
}
export const dayEndMs = (day: string): number => dayStartMs(day) + DAY_MS
export const nextDay = (day: string): string => new Date(dayEndMs(day)).toISOString().slice(0, 10)

/** The phases live on `day`: the `live` of the latest release at or before the day's start (UTC). Empty before any release. */
export function livePhases(markers: readonly ReleaseMarker[], day: string): Set<string> {
  const start = dayStartMs(day)
  const latest = markers.filter(m => m.atMs <= start).reduce<ReleaseMarker | null>((a, m) => (a === null || m.atMs > a.atMs ? m : a), null)
  return new Set(latest?.live ?? [])
}

export interface Carry { count: number }

/** The next record, from yesterday's count (0 when there is none). Pure. */
export function nextRecord(day: string, checks: Checks, markers: readonly ReleaseMarker[], prev: Carry | null): DayRecord {
  const start = dayStartMs(day), end = start + DAY_MS
  const releases = markers.filter(m => m.behaviour && m.atMs >= start && m.atMs < end).map(m => m.appSha)
  const live = livePhases(markers, day)
  const reasons: DayReason[] = []
  if (!REQUIRED_PHASES.every(p => live.has(p))) reasons.push('phases_not_live')
  if (releases.length > 0) reasons.push('release')
  if (checks.guards.status === 'unclean') reasons.push('bypass')
  if (checks.bell_notices.status === 'unclean') reasons.push('notice')
  if (CHECK_NAMES.some(n => checks[n].status !== 'clean')) reasons.push('check')
  const verdict = reasons.length === 0 ? 'clean' : 'not_clean'
  const count = verdict === 'clean' ? (prev?.count ?? 0) + 1 : 0
  return { day, checks, verdict, reasons, count, releases, passed: verdict === 'clean' && count >= GATE_DAYS }
}
