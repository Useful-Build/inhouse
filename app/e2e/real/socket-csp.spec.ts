// Acceptance 1 and 2 in a real browser (A5: assigned to W7 PR 2): the chat socket opens under the enforced CSP (`connect-src
// 'self'`, public/_headers) and carries an answer to the page. The CSP guard in ../support/test-build fails the test on any
// violation, so a socket the policy blocked can't pass: it would be reported and the answer would never arrive. A turn needs a
// container, so this runs on the per-PR test deployment (E2E_TEST_BUILD_REMOTE) and skips on the local test build.
// The turn plays the scripted model's `hello` scenario, named in the message text. No real model is called.
import { expect, test } from '../support/test-build/index.js'
import { open, originFor, signInAs } from '../support/clients/real.js'

test('A chat sent from the composer is answered over a same-origin socket, with no CSP violation', async ({ page, context }) => {
  test.skip(!process.env.E2E_TEST_BUILD_REMOTE, 'a turn needs a container: this runs on the per-PR test deployment')
  const reports: string[] = []
  page.on('request', r => { if (r.url().endsWith('/api/client-error')) reports.push(r.postData() ?? '') })
  const sockets: { url: string; received: number; closed: boolean }[] = []
  page.on('websocket', ws => {
    const s = { url: ws.url(), received: 0, closed: false }
    sockets.push(s)
    ws.on('framereceived', () => { s.received++ })
    ws.on('close', () => { s.closed = true })
  })
  await signInAs(context, 'dana')
  await open(page, 'dana', '#/today')
  await page.getByRole('textbox', { name: 'Ask your Inhouse agent' }).fill('scenario:hello can you hear me?')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  // The answer reaches the page.
  await expect(page.getByText('Hello from the scripted model.')).toBeVisible({ timeout: 120_000 })

  // It came over the chat socket: same origin (ws or wss), the route and version of the design, frames received, still open.
  const expected = `${originFor('dana').replace(/^http/, 'ws')}/api/socket?v=1`
  expect(sockets.map(s => s.url)).toContain(expected)
  const chat = sockets.find(s => s.url === expected)!
  expect(chat.received).toBeGreaterThan(0)
  expect(chat.closed, 'the socket stayed open while the answer arrived').toBe(false)
  expect(reports, `Client errors reported: ${reports.join(' | ')}`).toEqual([])
})
