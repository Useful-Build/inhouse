// The release smoke (P2 plan, "Orchestrator only"). Read only: it never writes, so it can run on a release, which the
// ship specs (they change data) must never do. Two service principals, as the Worker sees them: `smoke` (a Member-level
// principal with its own row) reads `/api/me` and one settings list; `monitor` reads the health route and is refused
// everywhere else. With no token the Worker answers 401.
//
// Two ways in, chosen by env:
//  - the test build (default, CI): the spec mints each service JWT with the test issuer, as e2e/api/kit.ts does;
//  - a release (SMOKE_BASE_URL set): the spec sends Access service-token headers and Access passes the Worker its own
//    `Cf-Access-Jwt-Assertion` JWT, so the Worker's checks are the same ones. The ids and secrets come from the env
//    vars named below, a missing one fails loudly, and none of them is ever logged or put in a message.
// Run: see AGENTS.md ("The product Worker (P2)") and the `verify` skill.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { z } from 'zod'
import { MeSchema } from '../../shared/contract/me.ts'
import { SettingsListSchema } from '../../shared/contract/settings.ts'
import { actor, call, expectError, fetchRaw, securityHeaders } from '../api/kit.ts'
import type { Reply } from '../api/kit.ts'

type Who = 'smoke' | 'monitor' | 'nobody'

const RELEASE_URL = process.env.SMOKE_BASE_URL
/** The env vars that hold each principal's Access service token on a release (Cloudflare's header pair, names below). */
const TOKEN_ENV = {
  smoke: { id: 'SMOKE_CLIENT_ID', secret: 'SMOKE_CLIENT_SECRET' },
  monitor: { id: 'MONITOR_CLIENT_ID', secret: 'MONITOR_CLIENT_SECRET' },
} as const

/**
 * The health route's body, a copy of server/ops/health.ts `HealthBody`. It can't be tied to that type at compile time:
 * importing it (even type-only) pulls the Worker's types into tsconfig.node.json (which typechecks e2e/), where
 * `Env`, `R2Bucket` and the rest don't exist. server/ops/health.test.ts holds the server's side of the shape.
 */
const HealthSchema = z.object({
  version: z.string().nullable(),
  ok: z.boolean(),
  signals: z.array(z.object({ name: z.string().min(1), ok: z.boolean(), detail: z.string().optional() })).min(1),
})

function releaseHeaders(who: 'smoke' | 'monitor'): Record<string, string> {
  const { id, secret } = TOKEN_ENV[who]
  const missing = [id, secret].filter(name => !process.env[name])
  // Names only, never values.
  if (missing.length > 0) throw new Error(`SMOKE_BASE_URL is set, so the ${who} service token is needed: set ${missing.join(' and ')}.`)
  // Access's service-token headers (Cloudflare Access docs, "Service tokens").
  return { 'CF-Access-Client-Id': process.env[id]!, 'CF-Access-Client-Secret': process.env[secret]! }
}

/** One read as `who`, on the release or on the test build. */
function read(request: APIRequestContext, who: Who, path: string): Promise<Reply> {
  if (RELEASE_URL) {
    const headers = who === 'nobody' ? {} : releaseHeaders(who)
    return fetchRaw(request, 'GET', `${new URL(RELEASE_URL).origin}${path}`, headers)
  }
  return call(request, actor(who === 'nobody' ? 'smoke' : who), 'GET', path, { token: who === 'nobody' ? null : undefined })
}

/** The headers every Worker answer carries (the same `/*` block of public/_headers that the `api` project checks). */
function expectSecure(r: Reply, what: string): void {
  for (const [name, value] of securityHeaders()) expect(r.headers[name], `${what}: ${name}`).toBe(value)
  expect(r.headers['cache-control'], `${what}: cache-control`).toBe('no-store')
}

test.describe('release smoke (read only)', () => {
  test('smoke: /api/me answers 200 with the smoke member', async ({ request }) => {
    const r = await read(request, 'smoke', '/api/me')
    expect(r.status, r.text).toBe(200)
    const me = MeSchema.parse(r.json)
    expect(me.role).toBe('member')
    expect(me.email, 'a service member has no email').toBeNull()
    expect(me.grant).toBeNull()
    expectSecure(r, 'smoke /api/me')
  })

  test('smoke: one settings read answers 200 and parses', async ({ request }) => {
    const r = await read(request, 'smoke', '/api/settings/brand')
    expect(r.status, r.text).toBe(200)
    SettingsListSchema.parse(r.json)
    expectSecure(r, 'smoke /api/settings/brand')
  })

  test('monitor: the health route answers 200 and parses', async ({ request }) => {
    const r = await read(request, 'monitor', '/api/health')
    expect(r.status, r.text).toBe(200)
    const health = HealthSchema.parse(r.json)
    expect(health.ok, 'every signal passes').toBe(true)
    expectSecure(r, 'monitor /api/health')
  })

  test('monitor: /api/me is refused (403)', async ({ request }) => {
    const r = await read(request, 'monitor', '/api/me')
    expectError(r, 403, 'forbidden')
    expectSecure(r, 'monitor /api/me')
  })

  test('smoke: /api/health is 403 forbidden (health is `monitor` only)', async ({ request }) => {
    const r = await read(request, 'smoke', '/api/health')
    expectError(r, 403, 'forbidden')
    expectSecure(r, 'smoke /api/health')
  })

  test('no token: /api/me is 401', async ({ request }) => {
    const r = await read(request, 'nobody', '/api/me')
    if (RELEASE_URL) {
      // On a release this accepts any refusal in front of the Worker. Access answers an unauthenticated request itself, before the Worker runs (a plain 403, or a
      // sign-in redirect), so the Worker's 401 and its headers aren't there to check. What counts is that nothing is served.
      expect([301, 302, 303, 307, 401, 403], `status ${r.status}`).toContain(r.status)
      expect(r.json?.memberId, 'no member data without a token').toBeUndefined()
    } else {
      expectError(r, 401, 'unauthorized')
      expectSecure(r, 'no token /api/me')
    }
  })
})
