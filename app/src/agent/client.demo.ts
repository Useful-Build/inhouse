// The demo client entry: the mock plus its switches. `npm run build` and every mode but `product` pick this one.
import type { ClientEntry } from './client-entry'
import { demoControlsFor } from './demo-controls'
import { demoClockFor } from './demo-clock'
import { MockAgent } from './mock'

const mock = new MockAgent()
const demo = demoControlsFor(mock)

export default {
  agent: mock,
  demo,
  now: demoClockFor(demo),
} satisfies ClientEntry
