// How the UI shows times and amounts: the one selector every formatting call reads its `Display` from (P1, C1).
// The demo shows times in the device's zone with US formats, so nothing changes on screen. P2 fills the product's from
// the brand's time zone setting (routine slots in P4 and the brand's day in P7 depend on it); the locale stays en-US
// until Wasim decides the format for UK brands (Q9).
// Still on the device's local time, for P2 to move onto the brand's zone: the demo clock itself (src/agent/demo-clock.ts:
// DEMO_START, `demoNow`, the sample times `demoAt` reads) and a routine's next run (`nextLocalRun` there, which the mock's
// `nextRun` calls). In the demo the display zone is the device's too, so the two agree; with a brand zone they wouldn't.
import { deviceTimeZone, type Display } from '../lib/format'
import { now } from '../agent'

let demoDisplay: Display | undefined
/** The `Display` every formatter takes. */
export const display = (): Display => (demoDisplay ??= { timeZone: deviceTimeZone(), locale: 'en-US' })

/**
 * Now, as epoch ms, for relative labels ("Today", "Yesterday", "just now"): the client entry's clock (the demo clock in the
 * demo, the real clock in the product). The state argument is kept so callers needn't change; it isn't read.
 */
export const nowOf = (_st?: unknown): number => now()
