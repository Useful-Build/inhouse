// Acceptance 9 on the test build: the enforced CSP (the guard in ../support/test-build) blocks neither the audit CSV
// download nor a member photo. The photo is uploaded through the app, then loads from /api/members/<id>/photo
// (img-src 'self'). It would fail if the CSP or the photo's own headers stopped the image, or the download.
import path from 'node:path'
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'

test('The audit CSV downloads and an uploaded photo loads under the CSP', async ({ page, context }) => {
  await signInAs(context, 'admin')

  await open(page, 'admin', '#/settings/team-audit')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download CSV' }).click()
  expect((await download).suggestedFilename()).toBe('inhouse-audit-log.csv')

  await open(page, 'admin', '#/settings/you-general')
  const photoRow = page.getByText('Photo', { exact: true }).locator('xpath=ancestor::div[.//input[@type="file"]][1]')
  await photoRow.locator('input[type=file]').setInputFiles(path.join(import.meta.dirname, '..', 'fixtures', 'photo.png'))
  const img = photoRow.locator('img[src^="/api/members/"]')
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0)
})
