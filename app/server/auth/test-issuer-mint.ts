// The test issuer's minting side (p2-design section 10): one RS256 key pair per run, its public JWKS for the Worker's
// `TEST_ISSUER_JWKS` var, and tokens shaped as Access sets them. Imported only by test code (unit tests, the Playwright
// helpers in e2e/support/test-build/issuer.ts, the seed); never by the Worker, and there is no mint route. WebCrypto
// only (through jose), so it runs in Node and in the Workers test pool alike.
// Claims per the Access docs (application token, checked 2026-11-20): a person has `sub`, `email`, `type: "app"` and
// `identity_nonce`; a service token has `sub: ""`, `common_name` (its client id), `type: "app"` and no `email`.
import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose'
import type { JSONWebKeySet, JWK } from 'jose'

export const TEST_ISSUER = 'https://test-issuer.invalid'

export interface TestIssuerKey {
  /** The private JWK, with `kid` and `alg: 'RS256'`. Stays with the test runner. */
  privateJwk: JWK
  /** The public JWKS, the only half the Worker gets. */
  jwks: JSONWebKeySet
}

/** A fresh RS256 key pair with a random `kid`. */
export async function newTestIssuerKey(): Promise<TestIssuerKey> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const kid = crypto.randomUUID()
  const pub = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }
  return { privateJwk: { ...(await exportJWK(privateKey)), kid, alg: 'RS256' }, jwks: { keys: [pub] } }
}

/** What every mint takes besides its claims. Times default to now, a 10-minute life and `nbf` at `iat`. */
export interface MintOptions {
  key: JWK
  /** The Access application's `aud` tag. */
  aud: string
  iss?: string
  /** Epoch ms for `iat` and `nbf`. */
  nowMs?: number
  lifetimeS?: number
  /** Overrides `nbf` (epoch ms). */
  nbfMs?: number
  /** Extra claims, set after the standard ones (tests use it to break a token). */
  extra?: Record<string, unknown>
}

async function mint(claims: Record<string, unknown>, sub: string, o: MintOptions): Promise<string> {
  if (!o.key.kid || o.key.alg !== 'RS256') throw new Error('The test issuer key needs a kid and alg RS256.')
  const nowS = Math.floor((o.nowMs ?? Date.now()) / 1000)
  return new SignJWT({ ...claims, type: 'app', ...o.extra })
    .setProtectedHeader({ alg: 'RS256', kid: o.key.kid })
    .setIssuer(o.iss ?? TEST_ISSUER)
    .setAudience([o.aud])
    .setSubject(sub)
    .setIssuedAt(nowS)
    .setNotBefore(o.nbfMs !== undefined ? Math.floor(o.nbfMs / 1000) : nowS)
    .setExpirationTime(nowS + (o.lifetimeS ?? 600))
    .sign(await importJWK(o.key, 'RS256'))
}

/** A person's token, as Access issues it after an identity-provider sign-in. */
export function mintPerson(p: { sub: string; email: string } & MintOptions): Promise<string> {
  return mint({ email: p.email, identity_nonce: crypto.randomUUID() }, p.sub, p)
}

/** A service token's JWT: `sub` empty, `common_name` the client id (`<id>.access`), no email. */
export function mintService(p: { clientId: string } & MintOptions): Promise<string> {
  return mint({ common_name: p.clientId }, '', p)
}
