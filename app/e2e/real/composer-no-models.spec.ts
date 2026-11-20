// The product has no models until chat arrives (P3), so every screen with the composer must render without them.
// The Worker logged a render crash on `/` (activeMode returned nothing, the Composer read `.id` of it). Specs here fail
// on any client error report, so a screen that throws can't pass by showing its error boundary.
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'

test('A signed-in Admin opens Today and a chat page with no models, and neither reports a client error', async ({ page, context }) => {
  const reports: string[] = []
  page.on('request', r => { if (r.url().endsWith('/api/client-error')) reports.push(r.postData() ?? '') })
  await signInAs(context, 'admin')

  await open(page, 'admin', '#/today')
  await expect(page.locator('[data-composer]')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Something went wrong.' })).toHaveCount(0)

  await open(page, 'admin', '#/chats')
  await expect(page.getByRole('main')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Something went wrong.' })).toHaveCount(0)
  expect(reports, `Client errors reported: ${reports.join(' | ')}`).toEqual([])
})
