// Profile photos: sample portraits show for the team, Sam can upload (cropped to a 256 px square) or remove his own,
// the new photo shows everywhere at once, a reload keeps it, and Reset demo brings the sample photo back.
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'
import path from 'node:path'
import { atRest } from './states.js'

async function start(page: Page, fx: Fx, hash = '#/settings/you-general') {
  await fx.seed({ stage: 'Act', demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'photo.png')
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const settingsButton = (page: Page) => side(page).getByRole('button', { name: /account and settings/i })
const sidebarImg = (page: Page) => settingsButton(page).locator('img')
const uploaded = 'img[src^="data:image/jpeg"]'
const shot = async (page: Page, name: string) => { await atRest(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const toast = (page: Page) => page.getByRole('status').filter({ hasText: /PNG, JPG or WebP|over 5 MB/ })

async function resetDemo(page: Page) {
  await page.getByRole('button', { name: /Demo switches/ }).click()
  await page.getByRole('button', { name: 'Reset demo' }).click()
  await page.getByRole('button', { name: 'Close demo switches' }).click()
  await expect(page.getByRole('heading', { level: 1 }).first()).toContainText('things need you')
}

test('Sample photos show for Sam and the team; Sam uploads, reloads, removes and resets', async ({ fx, page }) => {
  await start(page, fx)
  // Sample photos: sidebar, the Photo row and, on Members, all four people.
  await expect(sidebarImg(page)).toHaveAttribute('src', '/avatars/sam.svg')
  const photoRow = page.getByText('Photo', { exact: true }).locator('xpath=ancestor::div[.//input[@type="file"]][1]')
  await expect(photoRow.locator('img')).toHaveAttribute('src', '/avatars/sam.svg')
  await expect(photoRow.getByRole('button', { name: 'Upload' })).toBeVisible()
  await expect(photoRow.getByRole('button', { name: 'Remove' })).toBeVisible()
  await shot(page, '1-general-sample-photo')

  // Upload the PNG fixture (400x240: orange left, blue right). It is cropped to a centred 256 px square.
  await photoRow.locator('input[type=file]').setInputFiles(FIXTURE)
  await expect(sidebarImg(page)).toHaveAttribute('src', /^data:image\/jpeg/)
  await expect(photoRow.locator('img')).toHaveAttribute('src', /^data:image\/jpeg/)
  const px = await sidebarImg(page).evaluate(async (img: HTMLImageElement) => {
    await img.decode()
    const c = document.createElement('canvas'); c.width = c.height = img.naturalWidth
    const g = c.getContext('2d')!; g.drawImage(img, 0, 0)
    return { size: [img.naturalWidth, img.naturalHeight], left: [...g.getImageData(40, 128, 1, 1).data], right: [...g.getImageData(216, 128, 1, 1).data] }
  })
  expect(px.size).toEqual([256, 256])
  expect(px.left[0]).toBeGreaterThan(px.left[2] + 60)    // orange side
  expect(px.right[2]).toBeGreaterThan(px.right[0] + 60)  // blue side
  await shot(page, '2-general-after-upload')

  // The account menu shows it too.
  await settingsButton(page).click()
  await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible()
  await expect(page.locator(`${uploaded}`)).toHaveCount(3) // sidebar, menu and the Photo row
  await shot(page, '3-account-menu-after-upload')
  await page.keyboard.press('Escape')

  // Members shows the upload for Sam and sample photos for the others.
  await page.goto('/?demo#/settings/team-members')
  await expect(page.locator('img[src="/avatars/dana.svg"]')).toHaveCount(1)
  await expect(page.locator('img[src="/avatars/leo.svg"]')).toHaveCount(1)
  await expect(page.locator('img[src="/avatars/priya.svg"]')).toHaveCount(1)
  await expect(page.locator(uploaded)).toHaveCount(2) // sidebar and Sam's Members row
  await shot(page, '4-members')

  // A reload keeps it.
  await page.reload()
  await expect(sidebarImg(page)).toHaveAttribute('src', /^data:image\/jpeg/)

  // Remove shows initials, even though a sample photo exists.
  await page.goto('/?demo#/settings/you-general')
  await page.getByRole('button', { name: 'Remove' }).click()
  await expect(sidebarImg(page)).toHaveCount(0)
  await expect(settingsButton(page)).toContainText('SM')
  await page.reload()
  await expect(sidebarImg(page)).toHaveCount(0)
  await expect(settingsButton(page)).toContainText('SM')
  await shot(page, '5-general-removed')

  // Reset demo brings the sample photo back.
  await resetDemo(page)
  await expect(sidebarImg(page)).toHaveAttribute('src', '/avatars/sam.svg')
})

test('Who approves what, Activity and Usage show photos; bad files get an error toast', async ({ fx, page }) => {
  await start(page, fx, '#/settings/team-approvals')
  await expect(page.locator('img[src="/avatars/dana.svg"]')).toHaveCount(1) // Orders over $5,000 is Dana
  await page.goto('/?demo#/settings/you-general')
  const file = page.locator('input[type=file]')

  await file.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') })
  await expect(toast(page)).toHaveText(/Use a PNG, JPG or WebP image\./)
  await expect(sidebarImg(page)).toHaveAttribute('src', '/avatars/sam.svg')

  await file.setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(6 * 1024 * 1024) })
  await expect(toast(page)).toHaveText(/over 5 MB/)
  await expect(sidebarImg(page)).toHaveAttribute('src', '/avatars/sam.svg')

  // An image type that isn't readable fails loud, not silently.
  await file.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not really a png') })
  await expect(page.getByRole('status').filter({ hasText: "isn't a readable image" })).toBeVisible()
  await expect(sidebarImg(page)).toHaveAttribute('src', '/avatars/sam.svg')

  await page.goto('/?demo#/activity')
  await expect(page.locator('img[src="/avatars/dana.svg"]').first()).toBeVisible()
  await page.goto('/?demo#/usage')
  await page.getByRole('radiogroup', { name: 'Break down by' }).getByRole('radio', { name: 'Person' }).click()
  await expect(page.locator('[data-usage-row] img')).toHaveCount(4)
})

test('Phone (390): the sidebar, account menu, General, Members and an upload all show the photo', async ({ fx, page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await start(page, fx)
  await expect(page.getByText('Photo', { exact: true })).toBeVisible()
  await expect(page.locator('img[src="/avatars/sam.svg"]').first()).toBeVisible()
  await shot(page, 'phone-1-general-sample-photo')

  await page.getByRole('button', { name: 'Menu' }).click()
  await expect(sidebarImg(page)).toHaveAttribute('src', '/avatars/sam.svg')
  await shot(page, 'phone-2-sidebar')
  await settingsButton(page).click()
  await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible()
  await shot(page, 'phone-3-account-menu')
  await page.keyboard.press('Escape')

  await page.goto('/?demo#/settings/team-members')
  await expect(page.locator('img[src="/avatars/dana.svg"]')).toBeVisible()
  await shot(page, 'phone-4-members')

  await page.goto('/?demo#/settings/you-general')
  await page.locator('input[type=file]').setInputFiles(FIXTURE)
  await expect(page.locator(uploaded).first()).toBeVisible()
  await shot(page, 'phone-5-general-after-upload')
})
