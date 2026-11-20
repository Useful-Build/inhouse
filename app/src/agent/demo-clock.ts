// The demo's one clock (D5 in docs/history/UI_PLAN_2.md). Only the demo entry (client.demo.ts) and the mock import this
// file: the product build has no demo clock, and everything else takes "now" from `ClientEntry.now()` (see index.ts).
// The demo runs on Monday, November 16, 2026 from 8:00 AM in the device's local time (the time zone in Settings is a
// label; it doesn't move this clock), moving on with real time while it is open and stopping at
// 11:59 AM so the morning stays a morning. Everything a person does is stamped on this clock, never the computer's own
// time. Holds and timers keep using real epoch ms.

import type { Instant } from '../../shared/contract/common'
import { instantOf } from '../lib/format'

/** A unique string the product build check (scripts/check-product-build.mjs) looks for: it must never be in the product build. */
export const DEMO_CLOCK_MARKER = 'inhouse-canary:demo-clock'

/** Monday, November 16, 2026, 8:00 AM, in the device's local time. */
export const DEMO_START = new Date(2026, 10, 16, 8, 0, 0, 0)
/** The latest the demo clock reads: 11:59 AM the same morning. */
export const DEMO_LATEST = new Date(2026, 10, 16, 11, 59, 0, 0)

/** The demo's time now: DEMO_START plus the real time since `startedAt` (epoch ms), capped at DEMO_LATEST. */
export const demoNow = Object.assign(
  (startedAt: number, now: number = Date.now()): Date =>
    new Date(Math.min(DEMO_START.getTime() + Math.max(0, now - startedAt), DEMO_LATEST.getTime())),
  { marker: DEMO_CLOCK_MARKER },
)

/** A sample instant as the sample data writes it: days from the demo's Monday and a local time ("0d 07:42" today,
 *  "-1d 16:40" Sunday, "+4d 09:00" Friday). Local, so it reads the same in every time zone. Throws on anything else. */
export const demoAt = (rel: string): Instant => {
  const m = /^([+-]?\d+)d (\d\d):(\d\d)$/.exec(rel)
  if (!m || Number(m[2]) > 23 || Number(m[3]) > 59) throw new Error(`Not a sample time like "-1d 16:40": "${rel}"`)
  return instantOf(new Date(DEMO_START.getFullYear(), DEMO_START.getMonth(), DEMO_START.getDate() + Number(m[1]), Number(m[2]), Number(m[3])).getTime())
}
/** The demo's Monday at a minute since midnight: how a time stored before C1 ("8:03 AM", minute 483) becomes an instant. */
export const demoDayAt = (minute: number): Instant =>
  instantOf(new Date(DEMO_START.getFullYear(), DEMO_START.getMonth(), DEMO_START.getDate(), 0, minute).getTime())
