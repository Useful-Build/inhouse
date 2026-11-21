// Acceptance 1 and 2 in a real browser (A5: assigned to W7 PR 2): the chat socket opens under the enforced CSP (`connect-src
// 'self'`, public/_headers) and carries an answer to the page. The CSP guard in ../support/test-build fails the test on any
// violation, so a socket the policy blocked can't pass: it would be reported and the answer would never arrive. A turn needs a
// container, so this runs on the per-PR test deployment (E2E_TEST_BUILD_REMOTE) and skips on the local test build.
// The turn plays the scripted model's `hello` scenario, named in the message text. No real model is called.
import { expect, test } from '../support/test-build/index.js'
import { open, originFor, signInAs } from '../support/clients/real.js'

test('A chat sent from the composer is answered over a same-origin socket, with no CSP violation', async ({ page, context }) => {
  test.skip(!process.env.E2E_TEST_BUILD_REMOTE, 'a turn needs a container: this runs on the per-PR test deployment')
  // A cold container start can take a minute or two: the test's own timeout is longer than the wait for the answer below, so a
  // failed wait reports its error instead of the test timing out first.
  test.setTimeout(240_000)
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
  // Pick the model like a person would. The composer's default is Opus, but the scripted model answers only for the harness model
  // (Sonnet, the picker's "Fast"): on a phone the choices sit in the "+" menu, elsewhere in the model menu.
  // The model menu button ("Model: <label>", Composer.tsx) shows once the models are read, so wait for whichever control the
  // layout has before choosing: an immediate visibility check races that read and fell through to the phone's "+" on a desktop.
  const modelMenu = page.getByRole('button', { name: /^Model:/ })
  const plusMenu = page.getByRole('button', { name: 'Attach, tools and model' })
  await expect(modelMenu.or(plusMenu), 'the composer shows neither a "Model: ..." button nor an "Attach, tools and model" button').toBeVisible({ timeout: 60_000 })
  if (await modelMenu.isVisible()) await modelMenu.click()
  else await plusMenu.click()
  await page.getByRole('menuitemradio', { name: /^Fast/ }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  // The answer reaches the page. A scripted-model miss (the agent's own error text) is shown instead of the answer: fail on it at once
  // with what the page says, not after a timeout.
  const answer = page.getByText('Hello from the scripted model.')
  const miss = page.getByText(/scripted model miss/)
  await expect(answer.or(miss).first()).toBeVisible({ timeout: 150_000 })
  expect(await miss.count(), `the agent answered with an error: ${await miss.allTextContents().then(t => t.join(' | '))}`).toBe(0)
  await expect(answer).toBeVisible()

  // It came over the chat socket: same origin (ws or wss), the route and version of the design, frames received, still open.
  const expected = `${originFor('dana').replace(/^http/, 'ws')}/api/socket?v=1`
  expect(sockets.map(s => s.url)).toContain(expected)
  // Some socket to it carried frames and is still open (a reconnect in between must not fail the test).
  expect(sockets.some(s => s.url === expected && s.received > 0 && !s.closed), 'a chat socket received frames and stayed open').toBe(true)
  expect(reports, `Client errors reported: ${reports.join(' | ')}`).toEqual([])
})
