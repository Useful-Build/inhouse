// The recorder (brief section 7), run on the Mac by the orchestrator through the `live` vitest project:
//   npm --prefix app/hub run test:live -- record
// with SHOPIFY_STEP and friends set (step.ts lists them). No token or secret ever reaches this process. Without
// SHOPIFY_STEP it skips with a message, so a broader filter (or a plain `test:live`) never fails on it.
import { runStep } from './step'

// The live project's globals, typed here: this folder can't resolve `vitest` in CI (only app/hub/node_modules exists),
// and declaring them locally keeps test globals out of the hub's own type environment.
declare const test: { skipIf(skip: boolean): (name: string, fn: () => Promise<void>) => void }
declare const expect: (value: unknown) => { not: { toMatch(pattern: RegExp): void } }

const step = process.env.SHOPIFY_STEP
if (!step) console.log('record: skipped, SHOPIFY_STEP is not set (step.ts lists the variables)')

test.skipIf(!step)('record', async () => {
  const message = await runStep(process.env)
  console.log(message)
  expect(message).not.toMatch(/has differences/)
})
