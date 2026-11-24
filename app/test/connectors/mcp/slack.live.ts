// The nightly connector check against the P0 test workspace (P5 W5 section 1). Runs only from a trusted workflow with the house
// deployment's service token, never in ci.yml:
//   NIGHTLY_BASE_URL=… NIGHTLY_ACCESS_CLIENT_ID=… NIGHTLY_ACCESS_CLIENT_SECRET=… NIGHTLY_SLACK_CHANNEL_ID=…
//   NIGHTLY_SLACK_NOTICES_CHANNEL_ID=… [NIGHTLY_HOUSE=1] [NIGHTLY_ROTATION=1] [NIGHTLY_CODEMODE=1]
//   npm --prefix app/hub run test:live -- slack.live
// A missing variable fails the run. `NIGHTLY_HOUSE=1` adds the notice read-back (stage Act on the house brand), `NIGHTLY_ROTATION=1`
// the rotation check (only once Wasim turned rotation on), `NIGHTLY_CODEMODE=1` the Shopify code mode cases (branch A).
import { codeModeCases } from './codemode'
import { slackCases } from './cases'
import { httpNightlyHub, NIGHTLY_ENV } from './client'
import { runCases } from './run'

// The live project's globals, typed here (this folder can't resolve `vitest` in CI), as the Shopify nightly does.
declare const test: (name: string, options: { timeout: number }, fn: () => Promise<void>) => void
declare const expect: (value: unknown) => { toEqual(expected: unknown): void }

test('slack and code mode live', { timeout: 300_000 }, async () => {
  const env = process.env
  const missing = NIGHTLY_ENV.filter(k => !env[k])
  if (missing.length > 0) throw new Error(`nightly: ${missing.join(', ')} must be set (the check fails, never skips)`)
  const hub = httpNightlyHub(env)
  const cases = [
    ...slackCases(hub, { channelId: env.NIGHTLY_SLACK_CHANNEL_ID!, noticesChannelId: env.NIGHTLY_SLACK_NOTICES_CHANNEL_ID!, rotation: env.NIGHTLY_ROTATION === '1' }),
    ...(env.NIGHTLY_CODEMODE === '1' ? codeModeCases(hub) : []),
  ]
  const { failures } = await runCases(cases, { house: env.NIGHTLY_HOUSE === '1' })
  expect(failures).toEqual([])
})
