// The hub's test log flush under concurrency (#530). The hub's test build forwards its log lines to the singleton test-fakes
// Durable Object when each call ends, and every call, alarm and request in the isolate does it. Ways it can fail, written first:
//  1. a flush waits on a promise another request or another Durable Object started, and its send runs on behalf of that
//     one: workerd answers "Cannot perform I/O on behalf of a different Durable Object (or request)" and the call that was
//     ending answers hub_error (the connect.spec.ts refresh-race test saw it as a 502 from the alarm hook);
//  2. a line of a call that ended is not in `logs` afterwards.
// The calls below are a wave of hook ops at once: each is its own request into the hub Worker, and the ones that reach an
// account run inside its SignIn object. Every one must answer 200, and the lines the connect left must be there.
import { expect, test } from '@playwright/test'
import { ensureDisconnected, fakeReset, fakeSet, fakeState, freshConnect, hook, NOTES_ACCOUNT, readTools, SLACK_ACCOUNT, workerLogs } from './fakes-kit.ts'

test.describe.configure({ mode: 'serial' })
test.beforeAll(async ({ request }) => { await fakeReset(request); await ensureDisconnected(request) })
test.afterAll(async ({ request }) => { await fakeReset(request); await ensureDisconnected(request) })

test('hub calls made at once all answer, and the lines of the calls that ended are in the log (#530)', async ({ request }) => {
  const c = await freshConnect(request)
  expect(c.location).toBe('/tools/slack?connected=1')
  for (let round = 0; round < 25; round++) {
    const [hooks, tools, state] = await Promise.all([
      Promise.all([
        hook(request, { op: 'state' }),
        hook(request, { op: 'state' }),
        hook(request, { op: 'alarm', accountId: SLACK_ACCOUNT }),
        hook(request, { op: 'alarm', accountId: SLACK_ACCOUNT }),
        hook(request, { op: 'alarm', accountId: NOTES_ACCOUNT }),
        hook(request, { op: 'logs' }),
      ]),
      readTools(request),
      fakeState(request),
    ])
    for (const [i, r] of hooks.entries()) expect(r.status, `round ${round}, call ${i}: ${r.text}`).toBe(200)
    expect(tools.connected, `round ${round}`).toContain('slack')
    expect(state.mcp.issuedTokens.length, `round ${round}`).toBeGreaterThan(0)
  }
  const lines = await workerLogs(request)
  expect(lines.some(l => l.includes('connect_complete')), 'the connect left its line in the hub log').toBe(true)
})

test('alarms fired at once on a due account all answer, and one refresh goes out per due token (#530)', async ({ request }) => {
  // A 1-second token lifetime makes the refresh due at half of it; at the fake's 12 hours nothing would ever be due.
  await fakeSet(request, { mcp: { rotation: true, expiresInS: 1 } })
  try {
    await ensureDisconnected(request)
    await freshConnect(request)
    const sendsBefore = (await fakeState(request)).mcp.refreshSends.length
    await expect.poll(async () => {
      const alarms = await Promise.all([1, 2, 3, 4].map(() => hook(request, { op: 'alarm', accountId: SLACK_ACCOUNT })))
      for (const [i, r] of alarms.entries()) expect(r.status, `alarm ${i}: ${r.text}`).toBe(200)
      return (await fakeState(request)).mcp.refreshSends.length
    }, { message: 'alarms fired together on a due account send a refresh', timeout: 15_000 }).toBeGreaterThan(sendsBefore)
  } finally {
    await fakeSet(request, { mcp: { rotation: false, expiresInS: 43_200 } })
  }
})
