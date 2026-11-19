// How the UI shows times and amounts: the one selector every formatting call reads its `Display` from (P1, C1).
// The demo shows times in the device's zone with US formats, so nothing changes on screen. P2 fills the product's from
// the brand's time zone setting (routine slots in P4 and the brand's day in P7 depend on it); the locale stays en-US
// until Wasim decides the format for UK brands (Q9).
import { deviceTimeZone, type Display } from '../lib/format'
import { demoNow } from '../agent/clock'
import type { AgentState } from '../agent/types'

let demoDisplay: Display | undefined
/** The `Display` every formatter takes. */
export const display = (): Display => (demoDisplay ??= { timeZone: deviceTimeZone(), locale: 'en-US' })

/** Now, as epoch ms, for relative labels ("Today", "Yesterday", "just now"): the demo clock, from the agent's state. */
export const nowOf = (st: Pick<AgentState, 'demoStartedAt'>): number => demoNow(st.demoStartedAt).getTime()
