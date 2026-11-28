// A hub alarm firing while the hook's reads run (#530). The hub's test build forwards its log lines to the singleton test-fakes
// Durable Object at the end of every call and every alarm, and the hook's `state` op calls each account's SignIn object, so a
// refresh alarm that ends while `state` reads run flushes at the same moment as those reads. Ways it can fail, written first:
//  1. a flush started in one Durable Object runs its send on behalf of another (workerd: "Cannot perform I/O on behalf of a
//     different Durable Object"): the `status` call it ends answers an error and `state` answers 502 hub_error, as the refresh
//     race test in connect.spec.ts saw in #530 about once in fifty runs;
//  2. the hub's own alarm doesn't refresh (the positive control: without it a quiet pass could mean no alarm fired).
// The token lives one second, so the hub's own alarm is due at half of it and, after each refresh, again half a second later;
// `state` is read in waves until the alarm has sent four refreshes (a condition, not a wait), so its end-of-call flush
// overlaps the reads four times.
import { expect, test } from '@playwright/test'
import { ensureDisconnected, fakeReset, fakeSet, fakeState, freshConnect, hook } from './fakes-kit.ts'

test.beforeAll(async ({ request }) => { await fakeReset(request); await ensureDisconnected(request) })
test.afterAll(async ({ request }) => { await fakeReset(request); await ensureDisconnected(request) })

const WAVE = 6
const wave = (request: Parameters<typeof hook>[0]) => Promise.all(Array.from({ length: WAVE }, () => hook(request, { op: 'state' })))

test('state reads made while the hub\'s own refresh alarm fires all answer (#530)', async ({ request }) => {
  await fakeSet(request, { mcp: { rotation: true, expiresInS: 1 } })
  try {
    await freshConnect(request)
    const before = (await fakeState(request)).mcp.refreshSends.length
    await expect.poll(async () => {
      const replies = await wave(request)
      for (const [i, r] of replies.entries()) expect(r.status, `state ${i}: ${r.text}`).toBe(200)
      return Math.max(...replies.map(r => r.json.mcp.refreshSends.length as number))
    }, { message: "the hub's own alarm refreshed the token four times while the reads ran", timeout: 20_000 }).toBeGreaterThanOrEqual(before + 4)
  } finally {
    await fakeSet(request, { mcp: { rotation: false, expiresInS: 43_200 } })
  }
})
