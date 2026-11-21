// The fake Slack Web API (P5 W4, p5-w4.md section 11): `conversations.list`, `conversations.info`, `chat.postMessage`
// and `auth.test` on `slack.com/api/*`, for the hub's node tests and (through the test seam, an orchestrator line) its
// test build. The OAuth paths on slack.com are W1's fake (SLACK_OAUTH_PATHS); the seam routes by path. A token is valid
// when W1's `isIssuedToken` says so. Deterministic: no clock, no randomness (message ts from a counter). Bundled into the
// hub's TEST build only: relative imports and runtime globals, no npm package. Every id and name here is invented.
//
// `chat.postMessage` records every call's full parameters in `posts`. A call carrying any parameter other than the four
// the hub may send is a loud test failure: it's recorded in `violations` (every test asserts it stays empty) and
// answered with HTTP 500, so the hub reports it too.
import { isIssuedToken } from '../mcp/server'

/** Found in the hub's test bundle only (the bundle scan looks for this exact value). */
export const SLACK_UPSTREAM_CANARY = 'INHOUSE_SLACK_UPSTREAM_CANARY_5e1a'

/** slack.com paths this module answers (the seam's router sends the rest of slack.com to W1's fake). */
export const SLACK_WEB_PATHS = ['/api/conversations.list', '/api/conversations.info', '/api/chat.postMessage', '/api/auth.test'] as const

/** The only parameters `chat.postMessage` may carry, sorted. */
export const POST_PARAMS = ['channel', 'text', 'unfurl_links', 'unfurl_media'] as const

export type FakeChannel = {
  id: string
  name: string
  is_channel: boolean
  is_private: boolean
  is_archived: boolean
  is_member: boolean
  is_shared: boolean
  is_ext_shared: boolean
  is_org_shared: boolean
  is_pending_ext_shared: boolean
}

const base = { is_channel: true, is_private: false, is_archived: false, is_member: true, is_shared: false, is_ext_shared: false, is_org_shared: false, is_pending_ext_shared: false }

/** The invented workspace's channels (section 11). */
export const WEB_CHANNELS: readonly FakeChannel[] = [
  { ...base, id: 'C0TEST0001', name: 'ops-alerts' },
  { ...base, id: 'C0TEST0002', name: 'general' },
  { ...base, id: 'C0TEST0003', name: 'partner-shared', is_shared: true, is_ext_shared: true },
  { ...base, id: 'C0TEST0004', name: 'old-launch', is_archived: true },
  { ...base, id: 'C0TEST0005', name: 'design', is_member: false },
  { ...base, id: 'C0TEST0006', name: 'leadership', is_private: true },
  // Slack Connect seen from our side only: `is_ext_shared` alone, without `is_shared` (review round 1).
  { ...base, id: 'C0TEST0008', name: 'vendor-connect', is_ext_shared: true },
]

export type WebRequest = { path: string; method: string; params: Record<string, string>; authorized: boolean }

export class FakeSlackWeb {
  /** Every channel, by id; tests change a copy (a channel becoming shared, archived, left). */
  channels = new Map<string, FakeChannel>(WEB_CHANNELS.map(c => [c.id, { ...c }]))
  /** Every request, with its parameters (the canary and member-id checks read these). */
  requests: WebRequest[] = []
  /** Every `chat.postMessage` the fake accepted, with its full parameters. */
  posts: Record<string, string>[] = []
  /** Every forbidden parameter set seen on `chat.postMessage`. Always empty in a passing test. */
  violations: string[][] = []
  // ---- switches ----
  /** The next `chat.postMessage` answers `ratelimited` (HTTP 429, Retry-After 7). */
  rateLimitNextPost = false
  /** The next `chat.postMessage` answers this Slack error with HTTP 200. */
  failNextPost: string | null = null
  /** Throws on the next `chat.postMessage` after recording it (the hub call never answers). */
  throwNextPost = false
  /** Pages of `conversations.list` hold this many channels. */
  pageSize = 200
  /** Pads each channel object in a list or info answer with a `purpose` this long (real objects are about 1 KB). */
  padBytes = 0
  #ts = 0

  get hosts(): string[] {
    return ['slack.com']
  }

  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const method = req.method
    const params: Record<string, string> = {}
    for (const [k, v] of url.searchParams) params[k] = v
    if (method === 'POST') {
      const type = (req.headers.get('Content-Type') ?? '').split(';')[0]!.trim()
      if (type !== 'application/x-www-form-urlencoded') return json({ ok: false, error: 'invalid_form_data' })
      for (const [k, v] of new URLSearchParams(await req.text())) params[k] = v
    }
    const token = /^Bearer (.+)$/.exec(req.headers.get('Authorization') ?? '')?.[1] ?? ''
    const authorized = token.length > 0 && isIssuedToken(token)
    this.requests.push({ path: url.pathname, method, params, authorized })
    if (!(SLACK_WEB_PATHS as readonly string[]).includes(url.pathname)) return new Response('no fake', { status: 599 })
    if (!authorized) return json({ ok: false, error: token ? 'invalid_auth' : 'not_authed' })
    switch (url.pathname) {
      case '/api/auth.test':
        return json({ ok: true, team_id: 'T0TEST0001', user_id: 'U0TEST0001' })
      case '/api/conversations.info': {
        const c = this.channels.get(params.channel ?? '')
        return c ? json({ ok: true, channel: this.#padded(c) }) : json({ ok: false, error: 'channel_not_found' })
      }
      case '/api/conversations.list':
        return this.#list(params)
      default:
        return this.#post(params)
    }
  }

  #list(params: Record<string, string>): Response {
    const types = (params.types ?? 'public_channel').split(',')
    const all = [...this.channels.values()].filter(
      c => (types.includes('public_channel') && !c.is_private) || (types.includes('private_channel') && c.is_private),
    ).filter(c => !(params.exclude_archived === 'true' && c.is_archived))
    const start = params.cursor ? Number(params.cursor.replace(/^page_/, '')) : 0
    const size = Math.min(this.pageSize, Number(params.limit ?? '100'))
    const page = all.slice(start, start + size)
    const next = start + size < all.length ? `page_${start + size}` : ''
    return json({ ok: true, channels: page.map(c => this.#padded(c)), response_metadata: { next_cursor: next } })
  }

  #padded(c: FakeChannel): FakeChannel | (FakeChannel & { purpose: { value: string } }) {
    return this.padBytes > 0 ? { ...c, purpose: { value: 'p'.repeat(this.padBytes) } } : c
  }

  async #post(params: Record<string, string>): Promise<Response> {
    const extra = Object.keys(params).filter(k => !(POST_PARAMS as readonly string[]).includes(k))
    const missing = POST_PARAMS.filter(k => !(k in params))
    if (extra.length > 0 || missing.length > 0 || params.unfurl_links !== 'false' || params.unfurl_media !== 'false') {
      this.violations.push(Object.keys(params).sort())
      return json({ ok: false, error: 'fake_refused_parameters' }, 500)
    }
    if (this.throwNextPost) {
      this.throwNextPost = false
      this.posts.push({ ...params })
      throw new TypeError('fake: the answer was lost')
    }
    if (this.rateLimitNextPost) {
      this.rateLimitNextPost = false
      return json({ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '7' })
    }
    if (this.failNextPost) {
      const error = this.failNextPost
      this.failNextPost = null
      return json({ ok: false, error })
    }
    const c = this.channels.get(params.channel!)
    if (!c) return json({ ok: false, error: 'channel_not_found' })
    if (c.is_archived) return json({ ok: false, error: 'is_archived' })
    if (!c.is_member) return json({ ok: false, error: 'not_in_channel' })
    this.posts.push({ ...params })
    const ts = `1763800000.${String(++this.#ts).padStart(6, '0')}`
    return json({ ok: true, channel: c.id, ts, message: { text: params.text } })
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

/** The seam's upstream (an orchestrator line routes slack.com's Web API paths here in app/hub/testing/index.ts). */
export function createSlackWebUpstream(): FakeSlackWeb {
  return new FakeSlackWeb()
}
