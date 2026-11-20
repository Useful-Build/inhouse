// How the UI shows times and amounts: the one selector every formatting call reads its `Display` from (P1, C1).
// The demo shows times in the device's zone with US formats, so nothing changes on screen. P2 fills the product's from
// the brand's time zone setting (`g:tz`, through `setBrandZone`; routine slots in P4 and the brand's day in P7 depend on it); the locale stays en-US
// until Wasim decides the format for UK brands (Q9).
// Still on the device's local time, for P2 to move onto the brand's zone: the demo clock itself (src/agent/demo-clock.ts:
// DEMO_START, `demoNow`, the sample times `demoAt` reads) and a routine's next run (`nextLocalRun` there, which the mock's
// `nextRun` calls). In the demo the display zone is the device's too, so the two agree; with a brand zone they wouldn't.
import { deviceTimeZone, isTimeZone, type Display } from '../lib/format'

let shown: Display | undefined
let brandZone: (() => string | undefined) | undefined
/** The client entry's brand zone: the product's `g:tz` setting once settings load, nothing in the demo (it keeps the device's zone). */
export const setBrandZone = (fn: () => string | undefined): void => { brandZone = fn }
const refused = new Set<string>()
const accepted = new Set<string>()
/** Whether `Intl` takes the zone. A refused one is told once (never thrown in render) and the device's zone stands in. */
const usable = (timeZone: string): boolean => {
  if (accepted.has(timeZone)) return true
  if (refused.has(timeZone)) return false
  if (isTimeZone(timeZone)) { accepted.add(timeZone); return true }
  refused.add(timeZone)
  console.warn(`Inhouse: "${timeZone}" is not a time zone this browser knows. Showing times in the device's zone.`)
  return false
}
/** The `Display` every formatter takes: the brand's zone when there is one, else the device's. One object per zone, so React sees no change. */
let deviceZone: string | undefined
export const display = (): Display => {
  const brand = brandZone?.()
  const timeZone = brand && usable(brand) ? brand : (deviceZone ??= deviceTimeZone())
  return shown?.timeZone === timeZone ? shown : (shown = { timeZone, locale: 'en-US' })
}
let clock: (() => number) | undefined
/** The client entry's clock (the demo clock in the demo, the real clock in the product), set once by src/agent/index.ts. */
export const setNow = (fn: () => number): void => { clock = fn }

/** Now, as epoch ms, for relative labels ("Today", "Yesterday", "just now"). Throws when no entry has set the clock. */
export const nowOf = (): number => {
  if (!clock) throw new Error('nowOf: no clock set. src/agent/index.ts sets it when it loads; import the agent first.')
  return clock()
}
