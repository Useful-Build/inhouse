// P5 W4 brief "Tests" 2 (one escape level), 3 (the hub's re-check), 4 (fixed parameters and its readiness twin), 5 (the
// channel re-check), 8 (no `run` scope) at the hub, over W1's fake OAuth server and W4's fake Slack Web API. Expected
// strings and lists are literals written here, never read from the code under test.
import { fc, test } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallerScope } from '../../index/contract'
import { checkChannel, listChannels, postNotice } from './gateway'
import { postToSlack } from './post'
import { connectSlack, deliveryWorld, ORIGIN, SLACK, type DeliveryWorld } from './testing/kit'

const SERVER: CallerScope = { kind: 'server', job: 'notify', requestId: 'req-test' }
const RUN: CallerScope = { kind: 'run', runId: 'run-1', principalId: 'p-1', requestId: 'req-1' }
const NOTICE = 'n_AAAAAAAAAAAAAAAAAAAAAA'
const FOUR = ['channel', 'text', 'unfurl_links', 'unfurl_media']

let logs: string[] = []
beforeEach(() => {
  logs = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)))
})
afterEach(() => vi.restoreAllMocks())

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error!.code)
const message = (r: { ok: boolean; error?: { message: string } }) => (r.ok ? '' : r.error!.message)

async function connected(): Promise<DeliveryWorld> {
  const w = deliveryWorld()
  await connectSlack(w)
  return w
}

function assertFourOnly(w: DeliveryWorld) {
  expect(w.web.violations).toEqual([])
  for (const p of w.web.posts) expect(Object.keys(p).sort()).toEqual(FOUR)
  for (const p of w.web.posts) expect([p.unfurl_links, p.unfurl_media]).toEqual(['false', 'false'])
}

const unescapeOnce = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

describe('test 2: one escape level, end to end', () => {
  it('R&D, a < b and x > y reach Slack escaped exactly once', async () => {
    const w = await connected()
    const r = await postNotice(w.deps, SERVER, { accountId: SLACK, channelId: 'C0TEST0001', title: 'Q&A', text: 'R&D a < b x > y', noticeId: NOTICE })
    expect(code(r)).toBe('ok')
    expect(w.web.posts.map(p => p.text)).toEqual(['*Q&amp;A*\nR&amp;D a &lt; b x &gt; y'])
    expect(unescapeOnce(w.web.posts[0]!.text!)).toBe('*Q&A*\nR&D a < b x > y')
    assertFourOnly(w)
  })

  it('an already escaped entity is escaped again, never passed through (the server never pre-escapes)', async () => {
    const w = await connected()
    await postToSlack(w.stub, { channelId: 'C0TEST0001', title: 'T', text: '&lt;!here&gt;' })
    expect(w.web.posts[0]!.text).toBe('*T*\n&amp;lt;!here&amp;gt;')
  })
})

// The fragments a server that skipped the bounds could send (test 3's double).
const HOSTILE = [
  'https://evil.example.com/x', 'http://a.b', 'HTTPS://EVIL.COM', 'ftp://files.example.net', 'mailto:a@b.co', 'tel:+15550100',
  'slack://channel?id=C1', 'javascript:alert(1)', 'data:text/html,hi', 'www.example.com', 'WWW.EXAMPLE.ORG', 'example.com/path',
  'evil.co.uk', 'shop.example.io:8080', 'example[.]com', 'example(dot)com', 'example．com', 'bücher.de', 'xn--bcher-kva.de',
  '<@U0TEST0001>', '<!here>', '<!channel>', '<!everyone>', '<!subteam^S0TEST0001>', '<https://evil.com|click>', '<#C0TEST0002>',
  '@here', '@channel', '@everyone', '&', '<', '>', '\u202Eevil', '\u200Bzw', '\u0007bell', '\u0085c1', '\u{E0041}tag',
  'plain words', 'a < b', 'x > y', 'R&D', '10.0.0.1/admin',
]
const hostile = fc.array(fc.oneof(fc.constantFrom(...HOSTILE), fc.string({ maxLength: 8 })), { minLength: 1, maxLength: 12 }).map(a => a.join(' '))

describe('test 3: the hub re-checks whatever the server sent', () => {
  test.prop([hostile, hostile, fc.boolean()], { numRuns: 120 })('no URL, mention or raw < reaches chat.postMessage', async (title, text, withLink) => {
    const w = await connected()
    const r = await postToSlack(w.stub, { channelId: 'C0TEST0001', title: title.slice(0, 40), text, ...(withLink ? { link: { kind: 'chat' as const, id: 'chat_1' } } : {}) })
    if (!r.ok) {
      // Only the bounds may refuse here, and then nothing was posted.
      expect(r.error.code).toBe('invalid_args')
      expect(w.web.posts).toEqual([])
      return
    }
    const posted = w.web.posts[0]!.text!
    const appLink = `<${ORIGIN}/chats/chat_1|Open in Inhouse>`
    const body = withLink ? posted.slice(0, -(appLink.length + 1)) : posted
    if (withLink) expect(posted.endsWith(`\n${appLink}`)).toBe(true)
    expect(body).not.toMatch(/[<>]/)
    expect(body).not.toMatch(/:\/\//)
    expect(body).not.toMatch(/www\./i)
    expect(body).not.toMatch(/(?:^|\s)@(?:here|channel|everyone)/i)
// eslint-disable-next-line no-control-regex -- the oracle looks for control characters
    expect(body).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u)
    expect(body).not.toMatch(/(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|uk|de|example)\b/i)
    assertFourOnly(w)
  })
})

describe('test 4: fixed parameters, by construction', () => {
  it('extra keys on the request never reach Slack', async () => {
    const w = await connected()
    const req = { channelId: 'C0TEST0001', title: 'T', text: 'x', link_names: '1', parse: 'full', blocks: '[]', thread_ts: '1.1', username: 'u', icon_url: 'i' }
    expect(code(await postToSlack(w.stub, req as never))).toBe('ok')
    const viaGateway = { accountId: SLACK, channelId: 'C0TEST0002', title: 'T', text: 'y', noticeId: NOTICE, reply_broadcast: 'true', attachments: '[]' }
    expect(code(await postNotice(w.deps, SERVER, viaGateway as never))).toBe('ok')
    expect(w.web.posts.length).toBe(2)
    assertFourOnly(w)
  })

  const refused: [string, string, string][] = [
    ['U0TEST0001', 'invalid_args', 'channelId'],
    ['D0TEST0001', 'invalid_args', 'channelId'],
    ['G0TEST0001', 'invalid_args', 'channelId'],
    ['C0TEST0003', 'connect_refused', 'shared_channel'],
    ['C0TEST0004', 'connect_refused', 'archived'],
    ['C0TEST0006', 'connect_refused', 'not_public'],
    ['C0TEST0005', 'connect_refused', 'not_member'],
    ['C0TEST9999', 'connect_refused', 'not_found'],
  ]
  it.each(refused)('postToSlack to %s is refused (%s %s) and nothing is posted', async (channelId, c, detail) => {
    const w = await connected()
    const r = await postToSlack(w.stub, { channelId, title: 'T', text: 'x' })
    expect(code(r)).toBe(c)
    expect(message(r)).toContain(detail)
    expect(w.web.posts).toEqual([])
    if (c === 'invalid_args') expect(w.web.requests).toEqual([])
  })

  it("twin: a paused account answers paused on all three, and the fake sees no request", async () => {
    const w = await connected()
    expect(code(await w.core.setPaused(SLACK, true))).toBe('ok')
    expect(code(await postToSlack(w.stub, { channelId: 'C0TEST0001', title: 'T', text: 'x' }))).toBe('paused')
    expect(code(await w.core.slackChannelInfo(SLACK, 'C0TEST0001'))).toBe('paused')
    expect(code(await w.core.slackChannelList(SLACK))).toBe('paused')
    expect(w.web.requests).toEqual([])
  })

  it('twin: a needs-reconnect account (a private-search flip) answers scope_mismatch on all three, no request', async () => {
    const w = await connected()
    w.env.SLACK_PRIVATE_SEARCH = 'on'
    expect(code(await postToSlack(w.stub, { channelId: 'C0TEST0001', title: 'T', text: 'x' }))).toBe('scope_mismatch')
    expect(code(await w.core.slackChannelInfo(SLACK, 'C0TEST0001'))).toBe('scope_mismatch')
    expect(code(await w.core.slackChannelList(SLACK))).toBe('scope_mismatch')
    expect(w.web.requests).toEqual([])
  })

  it('a never-connected account answers not_configured with no request', async () => {
    const w = deliveryWorld()
    expect(code(await postToSlack(w.stub, { channelId: 'C0TEST0001', title: 'T', text: 'x' }))).toBe('not_configured')
    expect(w.web.requests).toEqual([])
  })
})

describe('test 5: the channel is re-checked at Slack on every post', () => {
  it('a channel that became shared after it was listed is refused', async () => {
    const w = await connected()
    expect(code(await postToSlack(w.stub, { channelId: 'C0TEST0002', title: 'T', text: 'x' }))).toBe('ok')
    w.web.channels.get('C0TEST0002')!.is_org_shared = true
    const r = await postToSlack(w.stub, { channelId: 'C0TEST0002', title: 'T', text: 'x2' })
    expect([code(r), message(r)]).toEqual(['connect_refused', 'connect refused by the provider: shared_channel'])
    expect(w.web.posts.length).toBe(1)
  })
})

describe('Slack answers, one send, no retry', () => {
  it('ratelimited maps to rate_limited with Retry-After, sent once', async () => {
    const w = await connected()
    w.web.rateLimitNextPost = true
    const r = await postToSlack(w.stub, { channelId: 'C0TEST0001', title: 'T', text: 'x' })
    expect(r).toEqual({ ok: false, error: { code: 'rate_limited', message: 'rate limited by the upstream', retryAfterMs: 7000 } })
    expect(w.web.requests.filter(q => q.path === '/api/chat.postMessage').length).toBe(1)
  })

  it('not_in_channel maps to connect_refused not_member; any other error to upstream_rejected with no Slack text', async () => {
    const w = await connected()
    w.web.failNextPost = 'not_in_channel'
    const a = await postToSlack(w.stub, { channelId: 'C0TEST0001', title: 'T', text: 'x' })
    expect([code(a), message(a)]).toEqual(['connect_refused', 'connect refused by the provider: not_member'])
    w.web.failNextPost = 'restricted_action'
    const b = await postToSlack(w.stub, { channelId: 'C0TEST0001', title: 'T', text: 'x' })
    expect([code(b), message(b)]).toEqual(['upstream_rejected', 'upstream rejected the request'])
    expect(w.web.requests.filter(q => q.path === '/api/chat.postMessage').length).toBe(2)
  })

  it('a lost answer is upstream_unavailable and is not re-sent', async () => {
    const w = await connected()
    w.web.throwNextPost = true
    expect(code(await postToSlack(w.stub, { channelId: 'C0TEST0001', title: 'T', text: 'x' }))).toBe('upstream_unavailable')
    expect(w.web.requests.filter(q => q.path === '/api/chat.postMessage').length).toBe(1)
  })
})

describe('the app link comes only from the typed link', () => {
  it.each([
    [{ kind: 'approval', id: 'ap_1' }, '/approvals/ap_1'],
    [{ kind: 'chat', id: 'c-9' }, '/chats/c-9'],
    [{ kind: 'today' }, '/'],
    [{ kind: 'activity' }, '/activity'],
    [{ kind: 'routine', id: 'rt_2' }, '/routines/rt_2'],
  ] as const)('%o opens %s', async (link, path) => {
    const w = await connected()
    expect(code(await postToSlack(w.stub, { channelId: 'C0TEST0001', title: 'T', text: 'x', link }))).toBe('ok')
    expect(w.web.posts[0]!.text).toBe(`*T*\nx\n<https://app.example.com${path}|Open in Inhouse>`)
  })

  it('a malformed link is dropped (and logged), the post still goes', async () => {
    const w = await connected()
    expect(code(await postToSlack(w.stub, { channelId: 'C0TEST0001', title: 'T', text: 'x', link: { kind: 'chat', id: '../x' } }))).toBe('ok')
    expect(w.web.posts[0]!.text).toBe('*T*\nx')
    expect(logs.some(l => l.includes('"link_dropped"'))).toBe(true)
  })

  it.each([undefined, '', 'http://app.example.com', 'https://app.example.com/path', 'https://evil.com|x'])('APP_ORIGIN %s: a linked post is not_configured, nothing sent', async origin => {
    const w = await connected()
    w.origin.value = origin
    expect(code(await postToSlack(w.stub, { channelId: 'C0TEST0001', title: 'T', text: 'x', link: { kind: 'today' } }))).toBe('not_configured')
    expect(w.web.posts).toEqual([])
  })
})

describe('test 8: the gateway refuses the runner and anything not server-shaped', () => {
  it('a run scope is refused on all three methods, with no request', async () => {
    const w = await connected()
    expect(code(await postNotice(w.deps, RUN, { accountId: SLACK, channelId: 'C0TEST0001', title: 'T', text: 'x', noticeId: NOTICE }))).toBe('invalid_args')
    expect(code(await listChannels(w.deps, RUN, { accountId: SLACK }))).toBe('invalid_args')
    expect(code(await checkChannel(w.deps, RUN, { accountId: SLACK, channelId: 'C0TEST0001' }))).toBe('invalid_args')
    expect(w.web.requests).toEqual([])
  })

  it('another account or a malformed notice id is refused', async () => {
    const w = await connected()
    expect(code(await postNotice(w.deps, SERVER, { accountId: 'shopify:store' as never, channelId: 'C0TEST0001', title: 'T', text: 'x', noticeId: NOTICE }))).toBe('invalid_args')
    expect(code(await postNotice(w.deps, SERVER, { accountId: SLACK, channelId: 'C0TEST0001', title: 'T', text: 'x', noticeId: 'n_short' }))).toBe('invalid_args')
    expect(w.web.requests).toEqual([])
  })
})

describe('listChannels and checkChannel', () => {
  it('lists public, unarchived channels with the shared flag, page by page', async () => {
    const w = await connected()
    w.web.pageSize = 2
    const ids: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 10; i++) {
      const r = await listChannels(w.deps, SERVER, { accountId: SLACK, ...(cursor ? { cursor } : {}) })
      if (!r.ok) throw new Error(r.error.code)
      ids.push(...r.value.channels.map(c => `${c.id}:${c.shared ? 'shared' : 'ok'}:${c.isMember ? 'member' : 'out'}`))
      if (!r.value.nextCursor) break
      cursor = r.value.nextCursor
    }
    expect(ids).toEqual(['C0TEST0001:ok:member', 'C0TEST0002:ok:member', 'C0TEST0003:shared:member', 'C0TEST0005:ok:out'])
    const sent = w.web.requests.filter(q => q.path === '/api/conversations.list')[0]!.params
    expect([sent.types, sent.exclude_archived, sent.limit]).toEqual(['public_channel', 'true', '200'])
  })

  it('checkChannel answers the channel as Slack sees it', async () => {
    const w = await connected()
    const r = await checkChannel(w.deps, SERVER, { accountId: SLACK, channelId: 'C0TEST0003' })
    expect(r).toEqual({ ok: true, value: { id: 'C0TEST0003', name: 'partner-shared', isMember: true, shared: true, archived: false, private: false } })
  })
})

describe('response caps (B2, 2026-11-21: 512 KiB for conversations.list only)', () => {
  function fill(w: DeliveryWorld, n: number) {
    for (let i = 0; i < n; i++) {
      const id = `C1TEST${String(i).padStart(4, '0')}`
      w.web.channels.set(id, { id, name: `team-${i}`, is_channel: true, is_private: false, is_archived: false, is_member: true, is_shared: false, is_ext_shared: false, is_org_shared: false, is_pending_ext_shared: false })
    }
  }
  it('a 200-channel page of about 1.2 KB a channel fits (about 240 KB, over the old 64 KiB)', async () => {
    const w = await connected()
    fill(w, 200)
    w.web.padBytes = 1000
    const r = await listChannels(w.deps, SERVER, { accountId: SLACK })
    expect(r.ok && r.value.channels.length).toBe(200)
  })
  it('a page over 512 KiB answers result_too_large', async () => {
    const w = await connected()
    fill(w, 200)
    w.web.padBytes = 2800
    expect(code(await listChannels(w.deps, SERVER, { accountId: SLACK }))).toBe('result_too_large')
  })
  it('conversations.info keeps 64 KiB: a 70 KB answer is result_too_large and nothing is posted', async () => {
    const w = await connected()
    w.web.padBytes = 70_000
    expect(code(await checkChannel(w.deps, SERVER, { accountId: SLACK, channelId: 'C0TEST0001' }))).toBe('result_too_large')
    expect(code(await postToSlack(w.stub, { channelId: 'C0TEST0001', title: 'T', text: 'x' }))).toBe('result_too_large')
    expect(w.web.posts).toEqual([])
  })
})

describe('logs', () => {
  it('hub_delivery carries the channel hash, never the id or the text', async () => {
    const w = await connected()
    await postToSlack(w.stub, { channelId: 'C0TEST0001', title: 'CANARY-TITLE-31', text: 'CANARY-TEXT-31' })
    const line = logs.map(l => JSON.parse(l) as Record<string, unknown>).find(l => l.event === 'hub_delivery')!
    expect(Object.keys(line).sort()).toEqual(['accountId', 'channelHash', 'code', 'event', 'ms'])
    // First 12 hex of SHA-256("C0TEST0001"), computed independently with node's crypto.
    const { createHash } = await import('node:crypto')
    expect(line.channelHash).toBe(createHash('sha256').update('C0TEST0001').digest('hex').slice(0, 12))
    expect(logs.join('\n')).not.toMatch(/CANARY-T|C0TEST0001/)
  })
})

// The contract spells the link kinds out (it imports nothing); tsc fails here if they drift from the shared table's.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const linkKindsAgree: Same<import('../../index/contract').NoticeLinkKind, import('../../../shared/notify/links').LinkKind> = true
describe('the contract', () => {
  it("NoticeLinkKind equals the shared table's LinkKind (checked by the type above)", () => expect(linkKindsAgree).toBe(true))
})
