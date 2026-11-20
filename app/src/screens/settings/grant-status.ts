// Where a support grant stands, as text: Off, live until a time, or ended at a time. A time that isn't today names its day.
import type { AgentData } from '../../agent/types'
import { fmtNearDay, fmtTime, fmtWhen } from '../../lib/format'
import type { Display } from '../../lib/format'

type Grant = AgentData['people']['supportGrant']
const when = (at: NonNullable<Grant>['endsAt'], now: number, d: Display) => {
  const t = fmtTime(at, d)
  return fmtWhen(at, now, d) === t ? t : `${fmtNearDay(at, now, d)}, ${t}`
}

export const grantStatus = (g: Grant, now: number, d: Display): string =>
  !g ? 'Off' : g.live ? `Live until ${when(g.endsAt, now, d)}` : `Ended ${when(g.endedAt ?? g.endsAt, now, d)}`
