// The nightly connector check against the read fixture store (brief section 8). Runs only from a trusted workflow
// with the store's secret, never in ci.yml:
//   SHOPIFY_SHOP=… SHOPIFY_CLIENT_ID=… SHOPIFY_CLIENT_SECRET=… npm --prefix app/hub run test:live -- live.live
// (`live.live`, so the filter never matches record.live.ts.) A missing variable fails the run. Prints case names and
// outcomes only.
import { loadCommittedFixture, runLive } from './live-run'

// The live project's globals, typed here: this folder can't resolve `vitest` in CI (only app/hub/node_modules exists),
// and declaring them locally keeps test globals out of the hub's own type environment.
declare const test: (name: string, options: { timeout: number }, fn: () => Promise<void>) => void
declare const expect: (value: unknown) => { toEqual(expected: unknown): void }

test('shopify live', { timeout: 300_000 }, async () => {
  const { failures } = await runLive(process.env, { upstream: req => fetch(req), committed: await loadCommittedFixture() })
  expect(failures).toEqual([])
})
