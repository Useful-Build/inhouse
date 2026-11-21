// The real client's side of the spec fixtures, beside clients/mock.ts: signing in on the test build as one of the
// seeded people (server/seed/brand.ts, W2) and opening the app there. The `real` project's specs and the ship spec in
// test-build mode use it, so none of them knows the test issuer or the seed's subjects.
// Access sets `Cf-Access-Jwt-Assertion` on each request it lets through; here the browser context sets it on every one
// (`extraHTTPHeaders`, so a spec that leaves the app's origin would send it there too: none does). The token is the
// test issuer's, for the app (brand or Inhouse) the page will open, and lasts 10 minutes: sign in per test.
import type { BrowserContext, Page, Response } from '@playwright/test'
import { SEED_INHOUSE, SEED_PEOPLE } from '../../../server/seed/brand.ts'
import { appOrigin, signIn } from '../test-build/issuer.js'
import type { AppName } from '../test-build/issuer.js'

export type { AppName } from '../test-build/issuer.js'

/** The seeded people on the brand app, with the names and emails the seed gave them: an Admin and two Members. */
export const people = SEED_PEOPLE
/** The seeded Inhouse team member, on the Inhouse app. */
export const inhouse = SEED_INHOUSE

export type Who = keyof typeof SEED_PEOPLE | 'inhouse'

/** The app a person belongs to: the seeded team on the brand app, the Inhouse team member on the Inhouse app. */
const appOf = (who: Who): AppName => (who === 'inhouse' ? 'inhouse' : 'brand')

/** Signs the context in as `who`: every request it makes from now on carries their token. Replaces an earlier sign-in. */
export async function signInAs(context: BrowserContext, who: Who): Promise<void> {
  const subject = who === 'inhouse' ? SEED_INHOUSE.subject : SEED_PEOPLE[who].subject
  await context.setExtraHTTPHeaders(await signIn(subject, appOf(who)))
}

/** Where the app is for `who`: `http://brand.localhost:<port>` or the Inhouse origin. */
export const originFor = (who: Who): string => appOrigin(appOf(who))

/** Opens the app as `who` at a route ("#/settings"). The context must be signed in as them (`signInAs`). */
export function open(page: Page, who: Who, hash = ''): Promise<Response | null> {
  return page.goto(`${originFor(who)}/${hash}`)
}
