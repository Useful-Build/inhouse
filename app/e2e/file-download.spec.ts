// A file in the conversation has a Download button: Download <file name>, which fetches it through the client and saves it.
// The demo serves a small sample file, so the whole path (chip, click, saved file) runs without a server. On the real client
// an attachment's download answers 404 until the composer's upload is wired to route 39 (the upload PR).
import { readFileSync } from 'node:fs'
import { expect, fxFor, test } from './support/fx.js'

test('Download: a sent attachment has a Download button that saves a file named like the chip', async ({ page }) => {
  await fxFor(page, undefined).seed({ stage: 'Act', demo: { ambient: 'Always' } })
  await page.goto('/?demo#/chats/stuck')
  const field = page.getByRole('textbox', { name: 'Message your Inhouse agent' })
  await expect(field).toBeFocused()
  await field.evaluate(el => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(4_200)], 'returns-week-46.csv', { type: 'text/csv' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await field.fill('What is in this file?')
  await page.locator('[data-composer]').getByRole('button', { name: 'Send' }).click()

  // The chip in the sent message, not the composer's (that one has Remove and no Download).
  const log = page.getByRole('log', { name: 'Conversation' })
  const download = log.getByRole('button', { name: 'Download returns-week-46.csv' })
  await expect(download).toBeVisible()
  await expect(download).toBeEnabled()

  const [saved] = await Promise.all([page.waitForEvent('download'), download.click()])
  expect(saved.suggestedFilename()).toBe('returns-week-46.csv')
  expect(readFileSync(await saved.path(), 'utf8')).toContain('A sample file from the demo.')
  // Back to ready once saved.
  await expect(download).toBeEnabled()
})
