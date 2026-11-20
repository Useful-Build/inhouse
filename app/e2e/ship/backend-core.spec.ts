// Ship spec for the backend core (P2): sign in, see your own name and role, change a setting, reload and it's there, the
// audit log shows it, a photo, a Member's limits, two tabs in conflict, the support grant, an invite and a refused
// person. S1 to S9 run on the TEST BUILD (`ship.yml` with build=test): the test issuer signs each seeded person in
// (e2e/support/clients/real.ts), so nothing here is a secret and no run touches a house or brand account.
// S10 (the demo preview is unchanged) is NOT in this file: the test build has no demo to open. It is a separate run, P1's whole
// ship spec on the PR's demo preview, a superset of its S1:
//   gh workflow run ship.yml -f pr=<number> -f spec=agent-seam.spec.ts -f build=demo
// Recorded at 1440x900 and 390x844. After the first load every page is opened through the UI, as a person would (the
// account menu, then Settings; on a phone the sidebar is the drawer behind Menu).
//
// Phone: team pages are read-only there, so there is no Grant, End now or Remove button. S7's grant and end and S9's
// removal call the same routes from the Admin's page on `ship-phone`, and every check of what the person then sees is in
// the browser as on desktop.
//
// Run (the ship workflow builds and serves the test build itself):
//   gh workflow run ship.yml -f pr=<number> -f spec=backend-core.spec.ts -f build=test
// Locally, after `npm run build:product-test` (heavy lock), with the test build served as ship.yml serves it:
//   SHIP=1 BASE_URL=http://brand.localhost:8787 TEST_BUILD_INHOUSE_URL=http://inhouse.localhost:8787 TEST_ISSUER_PRIVATE_JWK_FILE=<key file>
//   npx playwright test e2e/ship/backend-core.spec.ts --project=ship-desktop --project=ship-phone
//
// The desktop and the phone project share one local database, so every scenario starts from whatever the last one left:
// a name or time zone is picked as "not the current one", and each invited person is new.
import { deflateSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import type { BrowserContext, Page } from '@playwright/test'
import { AUDIT_CSV_HEADER } from '../../shared/csv.ts'
import { parseCsv } from '../api/kit.ts'
import { inhouse, originFor, people, signInAs } from '../support/clients/real.js'
import type { Who } from '../support/clients/real.js'
import { appOrigin, expect, signIn, test } from '../support/test-build/index.js'

const phone = () => test.info().project.name === 'ship-phone'

const main = (page: Page) => page.getByRole('main')
const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })
/** A settings row by its title (rows are the `py-4` blocks of a settings card). */
const row = (page: Page, title: string) => main(page).locator('div.py-4').filter({ has: page.getByText(title, { exact: true }) })

/** Waits for the app to have loaded for whoever the context is signed in as: the sidebar's account button, or Menu on a phone. */
async function ready(page: Page) {
  if (phone()) await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible()
  else await expect(page.getByRole('button', { name: /, account and settings$/ })).toBeVisible()
}

/** Opens the account menu (on a phone the drawer first). */
async function accountMenu(page: Page) {
  if (phone()) await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /, account and settings$/ }).click()
  const menu = page.getByRole('menu', { name: 'Account' })
  await expect(menu).toBeVisible()
  return menu
}

/** Closes the account menu, and on a phone the drawer behind it (Escape closes the menu alone, then the drawer), so Menu is reachable again. */
async function closeMenu(page: Page) {
  await page.keyboard.press('Escape')
  if (phone()) {
    await page.keyboard.press('Escape')
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden()
  }
}

/** Opens a Settings page from the account menu: "Your settings" or "Team settings", then the page in the Settings list. */
async function settingsPage(page: Page, group: 'Your settings' | 'Team settings', label: string) {
  const menu = await accountMenu(page)
  await menu.getByRole('menuitem', { name: group, exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: label, exact: true }).click()
  await expect(h1(page)).toHaveText(label)
}

/** Signs the context in as `who` and opens the app on a page, loaded. */
async function openAs(context: BrowserContext, page: Page, who: Who) {
  await signInAs(context, who)
  await page.goto(`${originFor(who)}/`)
  await ready(page)
}

/** Signs the context in as someone who isn't seeded (the test issuer mints any subject; its email is `<subject>@example.test`). */
async function signInSubject(context: BrowserContext, subject: string) {
  await context.setExtraHTTPHeaders(await signIn(subject, 'brand'))
}

/** A request from inside the page: same origin, so it carries the page's sign-in and its Origin (the API refuses a write without it). */
async function api(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return page.evaluate(async ([m, p, b]) => {
    const res = await fetch(p as string, { method: m as string, ...(b === null ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }) })
    return { status: res.status, json: await res.json().catch(() => null) }
  }, [method, path, body ?? null] as const)
}

/** The time zones the specs pick between (a Settings > General dropdown: its label, and the id the audit log shows). */
const ZONES = [
  { id: 'Europe/London', label: 'UK Time (London)' },
  { id: 'Europe/Dublin', label: 'Irish Time (Dublin)' },
  { id: 'Europe/Paris', label: 'Central European Time (Paris)' },
]
type Zone = (typeof ZONES)[number]
const zoneBox = (page: Page) => main(page).getByRole('combobox', { name: /^Time zone: / })

/** The first zone that isn't the one the page shows now, nor any in `not`: every run starts from the last run's value. */
async function otherZone(page: Page, not: Zone[] = []): Promise<Zone> {
  const shown = (await zoneBox(page).getAttribute('aria-label')) ?? ''
  const zone = ZONES.find(z => shown !== `Time zone: ${z.label}` && !not.includes(z))
  if (!zone) throw new Error(`No time zone to pick: the page shows "${shown}".`)
  return zone
}

/** Picks a zone and waits for the Worker's answer to the save (200, or the status given): a reload or another tab must not race it. */
async function pickZone(page: Page, zone: Zone, status = 200) {
  const answered = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/api/settings/brand/') && r.status() === status)
  await zoneBox(page).click()
  await page.getByRole('option', { name: zone.label, exact: true }).click()
  await answered
}

/** Opens the Invite window and sends it. */
async function invite(page: Page, who: { name: string; email: string }) {
  await main(page).getByRole('button', { name: 'Invite', exact: true }).click()
  const win = page.getByRole('dialog', { name: 'Invite someone' })
  await win.getByLabel('Name', { exact: true }).fill(who.name)
  await win.getByLabel('Work email').fill(who.email)
  await win.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(toast(page, `Invited ${who.name}.`)).toBeVisible()
}

/** A person nobody has invited yet: the test issuer mints their sign-in from the subject. */
function newPerson(label: string) {
  const id = crypto.randomUUID().slice(0, 8)
  const subject = `e2e-ship-${label}-${id}`
  return { subject, email: `${subject}@example.test`, name: `Ship ${label} ${id}` }
}

/** A small valid PNG (solid colour) built here, so nothing is read from disk. */
function png(size: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body))
    return Buffer.concat([head, body, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8 bits per channel, truecolour
  const line = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())])
  const raw = Buffer.concat(Array.from({ length: size }, () => line))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

test('S1: Open the app as the Admin and see your own name and role in the account menu', async ({ context, page }) => {
  await openAs(context, page, 'admin')
  const menu = await accountMenu(page)
  await expect(menu).toContainText(people.admin.name)
  await expect(menu).toContainText(`${people.admin.email} · Admin`)
})

test('S2: Change the time zone in Settings, reload, and it\'s still set', async ({ context, page }) => {
  await openAs(context, page, 'admin')
  await settingsPage(page, 'Your settings', 'General')
  const zone = await otherZone(page)
  await pickZone(page, zone)
  await page.reload()
  await ready(page)
  await settingsPage(page, 'Your settings', 'General')
  await expect(zoneBox(page)).toHaveAttribute('aria-label', `Time zone: ${zone.label}`)
})

test('S3: The audit log shows that change with your name and the time; Export CSV downloads it', async ({ context, page }) => {
  await openAs(context, page, 'admin')
  await settingsPage(page, 'Your settings', 'General')
  const zone = await otherZone(page)
  await pickZone(page, zone)
  // The audit list is read when the app loads (the plan's own measure is "change a setting, reload, the audit log shows it").
  await page.reload()
  await ready(page)
  await settingsPage(page, 'Team settings', 'Audit log')
  // The newest line first: the person, what they did, the setting and its value, and the time of day.
  const line = main(page).locator('div.py-4').filter({ hasText: `${people.admin.name} changed a setting` }).filter({ hasText: `Time zone: ${zone.id}` }).first()
  await expect(line).toBeVisible()
  await expect(line).toContainText(new RegExp(`Time zone: ${zone.id.replace('/', '\\/')}\\s*·\\s*\\d{1,2}:\\d{2}\\s*[AP]M`))
  // The button on the page is "Download CSV" (the plan's "Export CSV"). The file is the log as the server writes it.
  const [download] = await Promise.all([page.waitForEvent('download'), main(page).getByRole('button', { name: 'Download CSV' }).click()])
  expect(download.suggestedFilename()).toBe('inhouse-audit-log.csv')
  const rows = parseCsv(await readFile(await download.path(), 'utf8'))
  expect(rows[0]).toEqual([...AUDIT_CSV_HEADER])
  expect(rows.some(r => r[1] === people.admin.name && r[2] === 'changed a setting' && r[3] === `Time zone: ${zone.id}`), 'the new line is in the file').toBe(true)
})

test('S4: Upload a profile photo, reload, and it shows in your avatar', async ({ context, page }) => {
  await openAs(context, page, 'admin')
  await settingsPage(page, 'Your settings', 'General')
  // Start with none: an earlier run's photo would show the avatar before the upload does.
  await row(page, 'Photo').getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(main(page).locator('img')).toHaveCount(0)
  await page.locator('input[type="file"][aria-label="Photo file"]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png(48, [36, 99, 235]) })
  const avatar = main(page).locator('img')
  await expect(avatar).toHaveJSProperty('complete', true)
  await expect(avatar).toHaveCount(1)
  await page.reload()
  await ready(page)
  // The account menu's avatar, on both sizes: it is the image the Worker serves, decoded (a broken image has no width).
  const menu = await accountMenu(page)
  await expect(menu.locator('img')).toHaveJSProperty('naturalWidth', 256)
})

test('S5: As a Member, the team pages are read-only and an admin-only action isn\'t offered', async ({ context, page }) => {
  await openAs(context, page, 'dana')
  const menu = await accountMenu(page)
  await expect(menu).toContainText(`${people.dana.name}`)
  await expect(menu).toContainText(`${people.dana.email} · Member`)
  await closeMenu(page)
  // A team setting is text for a Member, not a control; a personal one is theirs to change.
  await settingsPage(page, 'Your settings', 'General')
  await expect(main(page).getByRole('textbox', { name: 'Name', exact: true })).toBeEnabled()
  await expect(zoneBox(page)).toHaveCount(0)
  await settingsPage(page, 'Team settings', 'Spending cap')
  await expect(main(page).getByText('Monthly cap', { exact: true })).toBeVisible()
  await expect(main(page).getByRole('textbox', { name: 'Monthly cap' })).toHaveCount(0)
  // The admin-only actions aren't offered: Invite, Remove and the support grant.
  await settingsPage(page, 'Team settings', 'Members')
  await expect(main(page).getByRole('button', { name: 'Invite', exact: true })).toHaveCount(0)
  await expect(main(page).getByRole('button', { name: /^Remove / })).toHaveCount(0)
  await settingsPage(page, 'Team settings', 'Data and access')
  await expect(main(page).getByText('Where your data stays', { exact: true })).toBeVisible()
  await expect(main(page).getByText('Inhouse team access', { exact: true })).toHaveCount(0)
  // The audit log is brand data a Member may read and export (access matrix rows 19 and 20), so its download is offered.
})

test('S6: Two tabs edit the same setting; the second save shows a conflict with the current value', async ({ context, page }) => {
  await openAs(context, page, 'admin')
  await settingsPage(page, 'Your settings', 'General')
  const second = await context.newPage()
  await second.goto(`${originFor('admin')}/`)
  await ready(second)
  await settingsPage(second, 'Your settings', 'General')
  // Both tabs hold the same record. The first saves a new zone; the second still holds the old record.
  const first = await otherZone(page)
  const later = await otherZone(second, [first])
  await pickZone(page, first)
  await pickZone(second, later, 409)
  await expect(toast(second, `Someone changed this. It's now ${first.label}.`)).toBeVisible()
  // The second tab shows what the setting is now, not what it tried to save.
  await expect(zoneBox(second)).toHaveAttribute('aria-label', `Time zone: ${first.label}`)
})

test('S7: The Admin grants the Inhouse team support access; the Inhouse principal sees the audit log. After the grant ends, the audit log is refused, the technical settings and grants still load, and the audit log shows the grant and its end', async ({ context, page, request }) => {
  await openAs(context, page, 'admin')
  // Start with no grant: one left by a failed run would make "Grant" a 409.
  const open = await api(page, 'GET', '/api/grants')
  expect(open.status).toBe(200)
  for (const g of open.json.items.filter((x: { live: boolean }) => x.live)) expect((await api(page, 'POST', `/api/grants/${g.id}/end`, { ifRev: g.rev })).status).toBe(200)
  await settingsPage(page, 'Team settings', 'Data and access')
  const access = row(page, 'Inhouse team access')
  // Team pages are read-only on a phone, so the grant is given and ended through the same route the buttons call.
  if (phone()) {
    expect((await api(page, 'POST', '/api/grants', { hours: 1 })).status).toBe(201)
    await page.reload()
    await ready(page)
    await settingsPage(page, 'Team settings', 'Data and access')
  } else {
    await access.getByRole('combobox', { name: /^Give access for/ }).click()
    await page.getByRole('option', { name: '1 hour', exact: true }).click()
    await access.getByRole('button', { name: 'Grant', exact: true }).click()
  }
  await expect(access).toContainText('Live until')

  // The Inhouse team member, on the Inhouse app: the audit log is open to them while the grant is live.
  await signInAs(context, 'inhouse')
  const alex = await context.newPage()
  await alex.goto(`${originFor('inhouse')}/`)
  await ready(alex)
  await expect(await accountMenu(alex)).toContainText('Inhouse team')
  await closeMenu(alex)
  await settingsPage(alex, 'Team settings', 'Audit log')
  await expect(main(alex)).toContainText('gave the Inhouse team access')

  // The Admin ends it (End now; the route the button calls on a phone).
  await signInAs(context, 'admin')
  if (phone()) {
    const live = (await api(page, 'GET', '/api/grants')).json.items.find((g: { live: boolean }) => g.live)
    expect((await api(page, 'POST', `/api/grants/${live.id}/end`, { ifRev: live.rev })).status).toBe(200)
    await page.reload()
    await ready(page)
    await settingsPage(page, 'Team settings', 'Data and access')
  } else await access.getByRole('button', { name: 'End now', exact: true }).click()
  await expect(access).toContainText('Ended')

  // The Inhouse team again: the audit log is refused, what the grant never covered still loads.
  await signInAs(context, 'inhouse')
  await alex.reload()
  await ready(alex)
  await settingsPage(alex, 'Team settings', 'Audit log')
  await expect(main(alex)).toContainText('Nothing changed yet')
  await expect(main(alex)).not.toContainText('gave the Inhouse team access')
  await expect(main(alex).getByRole('button', { name: 'Download CSV' })).toHaveCount(0)
  await settingsPage(alex, 'Team settings', 'Data and access')
  await expect(row(alex, 'Inhouse team access')).toContainText('Ended')
  // What the grant never covered still opens: Stage and plan reads the technical settings, and the seeded stage shows.
  await settingsPage(alex, 'Team settings', 'Stage and plan')
  await expect(row(alex, 'Current stage')).toContainText('Watch')
  const sign = await signIn(inhouse.subject, 'inhouse')
  const at = (path: string) => request.get(`${appOrigin('inhouse')}${path}`, { headers: sign })
  expect((await at('/api/audit')).status()).toBe(403)
  expect((await at('/api/grants')).status(), 'the grant list is baseline').toBe(200)
  expect((await at('/api/settings/technical')).status(), 'technical settings are baseline').toBe(200)

  // The Admin's audit log keeps the whole story: the grant, its use and its end.
  await signInAs(context, 'admin')
  await page.reload()
  await ready(page)
  await settingsPage(page, 'Team settings', 'Audit log')
  await expect(main(page)).toContainText(`${people.admin.name} gave the Inhouse team access`)
  await expect(main(page)).toContainText('looked at brand data')
  await expect(main(page)).toContainText(new RegExp(`${people.admin.name} ended the Inhouse team.s access`))
})

test('S8: The Admin invites a person; their first sign-in lands as a Member with their name', async ({ context, page }) => {
  const who = newPerson('invitee')
  await openAs(context, page, 'admin')
  await settingsPage(page, 'Team settings', 'Members')
  await invite(page, who)
  // The list names them; the "Invited" tag is on the role control, which a phone doesn't show.
  await expect(main(page).getByText(who.name, { exact: true })).toBeVisible()
  if (!phone()) await expect(row(page, who.name)).toContainText('Invited')

  await signInSubject(context, who.subject)
  const theirs = await context.newPage()
  await theirs.goto(`${appOrigin('brand')}/`)
  await ready(theirs)
  const menu = await accountMenu(theirs)
  await expect(menu).toContainText(who.name)
  await expect(menu).toContainText(`${who.email} · Member`)
})

test('S9: A person who wasn\'t invited sees "You\'re not on this team". A removed member\'s next request is refused', async ({ context, page, request }) => {
  // Never invited.
  const stranger = newPerson('stranger')
  await signInSubject(context, stranger.subject)
  await page.goto(`${appOrigin('brand')}/`)
  await expect(h1(page)).toHaveText("You're not on this team")
  await expect(main(page)).toContainText('Ask an admin to invite you')

  // Invited, signed in once, then removed by the Admin.
  const leaver = newPerson('leaver')
  await openAs(context, page, 'admin')
  await settingsPage(page, 'Team settings', 'Members')
  await invite(page, leaver)
  await signInSubject(context, leaver.subject)
  const theirs = await context.newPage()
  await theirs.goto(`${appOrigin('brand')}/`)
  await ready(theirs)
  await expect(await accountMenu(theirs)).toContainText(leaver.name)

  // The Admin's page still holds the invite as it was before the first sign-in (a stale record: removing it would be a
  // conflict), so the Admin reloads, as a person would to see the invite become a member.
  await signInAs(context, 'admin')
  await page.reload()
  await ready(page)
  await settingsPage(page, 'Team settings', 'Members')
  if (phone()) {
    // The Remove button is on the desktop page only (team pages are read-only on a phone): the same route, from the page.
    const list = await api(page, 'GET', '/api/members?limit=100')
    const found = list.json.items.find((m: { email: string }) => m.email === leaver.email)
    expect((await api(page, 'DELETE', `/api/members/${found.id}?ifRev=${found.rev}`)).status).toBe(200)
  } else {
    await main(page).getByRole('button', { name: `Remove ${leaver.name}` }).click()
    await page.getByRole('dialog', { name: `Remove ${leaver.name}?` }).getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(main(page).getByText(leaver.name, { exact: true })).toHaveCount(0)
  }

  // Their very next request is refused, and the page says so.
  await signInSubject(context, leaver.subject)
  expect((await request.get(`${appOrigin('brand')}/api/me`, { headers: await signIn(leaver.subject, 'brand') })).status()).toBe(403)
  await theirs.reload()
  await expect(h1(theirs)).toHaveText("You're not on this team")
})
