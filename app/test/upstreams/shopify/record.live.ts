// The recorder (brief section 7), run on the Mac by the orchestrator through the `live` vitest project:
//   npm --prefix app/hub run test:live -- record
// with SHOPIFY_STEP and friends set (step.ts lists them). No token or secret ever reaches this process.
import { expect, test } from 'vitest'
import { runStep } from './step'

test('record', async () => {
  const message = await runStep(process.env)
  console.log(message)
  expect(message).not.toMatch(/has differences/)
})
