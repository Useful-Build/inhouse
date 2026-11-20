// The demo client entry: the mock plus its switches. `npm run build` and every mode but `product` pick this one.
import type { ClientEntry } from './client-entry'
import { demoControlsFor } from './demo-controls'
import { demoNow } from './demo-clock'
import { MockAgent } from './mock'

const mock = new MockAgent()

export default {
  agent: mock,
  demo: demoControlsFor(mock),
  now: () => demoNow(mock.getSnapshot().demoStartedAt).getTime(),
} satisfies ClientEntry
