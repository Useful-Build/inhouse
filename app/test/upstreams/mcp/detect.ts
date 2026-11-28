// Detect's addresses (Stage 1 M4-F, N37, N52; connect plan section 5 step 0 and checklist 1): six addresses, one per
// outcome, plus the hostile ones detect must refuse. Bundled into the hub's TEST build only: no npm package.
//
// Each address answers as the spec pages say, with no credential:
// - open: 2026-07-28 server/discover and tools/list answer (server/tools, server/discover).
// - signin: 401 with a Bearer challenge naming its resource metadata (basic/authorization, RFC 9728 section 5.1); the
//   metadata names a login server that offers a Client ID Metadata Document and registration (client-registration).
// - signin_needs_app: the same, but the login server offers neither (Executor's integrations guide: Google, GitHub).
// - key: 401 with a non-Bearer challenge and no resource metadata at either well-known address.
// - blocked: a firewall's challenge page (403, HTML, `cf-mitigated: challenge`), and two addresses that redirect (one
//   same origin, one cross origin): detect never follows one (N37).
// - not_mcp: a REST API's base address: 404 with a plain JSON error, no challenge (Path C's fixture, ../rest/).
// - private metadata: a protected resource whose metadata names a login server at a private address. The address is
//   registered as a trap: any request that reaches it is in the log, so "the hop was refused" is provable.
// A detect probe's request log (index.ts `log`) shows each line it sent: the control for "no redirect followed, no
// credential, no registration, no tool call".

import { HOSTS, json } from './wire'

export type DetectOutcome = 'open' | 'signin' | 'signin_needs_app' | 'key' | 'blocked' | 'not_mcp'

/** One address per outcome (connect plan checklist 1: "Six fixture addresses report the six outcomes"). */
export const DETECT_ADDRESSES: Record<DetectOutcome, string> = {
  open: `https://${HOSTS.modern}/open/mcp`,
  signin: `https://${HOSTS.modern}/mcp`,
  signin_needs_app: `https://${HOSTS.modern}/as/noreg/mcp`,
  key: `https://${HOSTS.modern}/key/mcp`,
  blocked: `https://${HOSTS.blocked}/mcp`,
  not_mcp: `https://${HOSTS.rest}/api/v1`,
}

/**
 * Key servers detect can't tell from the scheme alone (#625): N37 splits `signin` from `key` on the metadata. One
 * answers a bare `Bearer` challenge with no resource metadata (its key goes in `Authorization: Bearer`), one answers
 * no challenge at all. Both are `key`.
 */
export const DETECT_KEY_VARIANTS = {
  bearerChallenge: `https://${HOSTS.modern}/key-bearer/mcp`,
  noChallenge: `https://${HOSTS.modern}/key-none/mcp`,
} as const

/** The hostile addresses, and what detect must make of each. */
export const DETECT_HOSTILE = {
  /** 308 to `/open/mcp` on the same origin: `blocked`, never followed. */
  redirectSameOrigin: { url: `https://${HOSTS.modern}/moved/mcp`, outcome: 'blocked' },
  /** 307 to another origin's open server: `blocked`, never followed. */
  redirectCrossOrigin: { url: `https://${HOSTS.redirect}/mcp`, outcome: 'blocked' },
  /** Its metadata names a login server at a private address: refused, the hop never sent. */
  privateMetadata: { url: `https://${HOSTS.modern}/private-meta/mcp`, outcome: 'refused' },
  /** A 2025-11-25 server: open, found by the fallback to `initialize`. */
  legacyOpen: { url: `https://${HOSTS.legacy}/mcp`, outcome: 'open' },
} as const

/** What a firewall in front of a tool answers (a challenge page, not the tool). */
export const FIREWALL_PAGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><h1>Checking your browser</h1><p>UPSTREAM TEXT: enable JavaScript and cookies to continue.</p></body></html>'

export function blockedFetch(_req: Request): Promise<Response> {
  return Promise.resolve(new Response(FIREWALL_PAGE, { status: 403, headers: { 'Content-Type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge', 'Cache-Control': 'no-store' } }))
}

export function redirectFetch(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (url.pathname === '/mcp') return Promise.resolve(new Response(null, { status: 307, headers: { Location: `https://${HOSTS.modern}/open/mcp` } }))
  return Promise.resolve(json({ error: 'not_found' }, 404))
}

/** The private-address trap: answers like a login server would, so only the log tells that a hop got here. */
export function privateTrapFetch(_req: Request): Promise<Response> {
  return Promise.resolve(json({ issuer: `https://${HOSTS.privateTrap}`, authorization_endpoint: `https://${HOSTS.privateTrap}/authorize`, token_endpoint: `https://${HOSTS.privateTrap}/token` }))
}
