// Signing in for the real targets, and talking to the test build without the client (the reset and `writeElsewhere` use
// it). A person is a seeded one (server/seed/brand.ts, W2): the test issuer (W1's test-issuer-mint.ts) signs them in with
// the key serve.ts made for this run. Under Node the request carries `Cf-Access-Jwt-Assertion` and an `Origin`, as
// Access and the browser would. Fixtures come from the seed: ids are looked up by email, never written in a test.
import type { JWK } from 'jose'
import { SEED_INVITE, SEED_PEOPLE } from '../../../../../server/seed/brand'
import { mintPerson } from '../../../../../server/auth/test-issuer-mint'
import type { Me, MemberRecord } from '../../../types'

/** serve.ts puts the run's private key and the brand app's `aud` in the environment (`process` isn't typed in this program). */
const env: Record<string, string | undefined> = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const need = (name: string): string => {
  const v = env[name]
  if (!v) throw new Error(`The real contract target needs ${name} in the environment: run it through e2e/support/test-build/serve.ts.`)
  return v
}

export type Seeded = keyof typeof SEED_PEOPLE
export const SEED = SEED_PEOPLE
export { SEED_INVITE }

/** Token headers for a seeded person on the brand app. A token lives 10 minutes; one is made per request batch, cached for 5. */
export function signer(origin: string) {
  const key = JSON.parse(need('INHOUSE_TEST_ISSUER_PRIVATE_JWK')) as JWK
  const aud = need('CONTRACT_REAL_BRAND_AUD')
  const cache = new Map<string, { at: number; jwt: string }>()
  const jwt = async (subject: string): Promise<string> => {
    const hit = cache.get(subject)
    if (hit && Date.now() - hit.at < 300_000) return hit.jwt
    const made = await mintPerson({ key, aud, sub: subject, email: `${subject}@example.test` })
    cache.set(subject, { at: Date.now(), jwt: made })
    return made
  }
  return {
    origin,
    /** What the client adds to every request as `who`. */
    headers: (who: Seeded) => async (): Promise<Record<string, string>> => ({ 'Cf-Access-Jwt-Assertion': await jwt(SEED_PEOPLE[who].subject), Origin: origin }),
    /** One request as `who`, outside the client: the status and the JSON body (undefined when there is none). */
    async api(who: Seeded, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
      const headers: Record<string, string> = { Accept: 'application/json', 'Cf-Access-Jwt-Assertion': await jwt(SEED_PEOPLE[who].subject), Origin: origin }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const res = await fetch(origin + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      const text = await res.text()
      return { status: res.status, json: text ? JSON.parse(text) : undefined }
    },
  }
}
export type Signer = ReturnType<typeof signer>

/** Every member the brand has, all pages. */
export async function allMembers(s: Signer, who: Seeded): Promise<MemberRecord[]> {
  const out: MemberRecord[] = []
  for (let cursor = ''; ;) {
    const r = await s.api(who, 'GET', `/api/members${cursor}`)
    if (r.status !== 200) throw new Error(`The real contract target couldn't list the team as ${who}: ${r.status}`)
    out.push(...r.json.items)
    if (!r.json.nextCursor) return out
    cursor = `?cursor=${encodeURIComponent(r.json.nextCursor)}`
  }
}

/** Who the seed made, by id: looked up through the API by email (an id is random, so no test can name one). */
export async function discover(s: Signer): Promise<Record<Seeded | 'invite', string>> {
  const members = await allMembers(s, 'admin')
  const idOf = (email: string) => {
    const m = members.find(x => x.email === email)
    if (!m) throw new Error(`The seeded brand has nobody with ${email}: was the test build seeded (npm run test-build:seed)?`)
    return m.id
  }
  return { admin: idOf(SEED_PEOPLE.admin.email), dana: idOf(SEED_PEOPLE.dana.email), leo: idOf(SEED_PEOPLE.leo.email), invite: idOf(SEED_INVITE.email) }
}

/** Who is signed in as `who`, or null when the brand refuses them (removed). */
export async function whoAmI(s: Signer, who: Seeded): Promise<Me | null> {
  const r = await s.api(who, 'GET', '/api/me')
  return r.status === 200 ? r.json : null
}
