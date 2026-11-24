// P5 W4 brief "Tests" 1 (the bounds, property) and the link table. The oracle is written here, separately from
// bound.ts: its own URL, host and mention detectors and hand-written literal cases. Nothing takes its expected value from
// the code under test.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { boundBody, boundNotice, composeSlack, escapedLength, LINK_REMOVED, TEXT_MAX, TITLE_MAX } from './bound.ts'
import { bellLink, checkLink, linkPath } from './links.ts'

// ---------- the oracle (independent detectors) ----------
const ORACLE_HOST = /(?:[a-z0-9\u00C0-\u{10FFFF}-]+\.)+(?:[a-z\u00C0-\u{10FFFF}]{2,}|xn--[a-z0-9-]+)(?![a-z0-9])/iu
const ORACLE_IP = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/
const ORACLE_SCHEME = /\b(?:https?|ftp|mailto|tel|sms|slack|data|javascript|vbscript|file):(?=\S)/i
// eslint-disable-next-line no-control-regex -- the oracle looks for control characters
const ORACLE_CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u
const cp = (s: string) => [...s].length

function assertClean(s: string) {
  expect(s).not.toContain('://')
  expect(s).not.toMatch(/www\./i)
  expect(s).not.toMatch(ORACLE_HOST)
  expect(s).not.toMatch(ORACLE_IP)
  expect(s).not.toMatch(ORACLE_SCHEME)
  expect(s).not.toMatch(ORACLE_CONTROL)
}

const FRAGMENTS = [
  'https://evil.example.com/a?b=c', 'http://a.b', 'HTTPS://X.COM', 'ftp://f.example.net', 'x-y+z.q://odd', '://nohost',
  'mailto:a@b.co', 'tel:+15550100', 'sms:+15550100', 'slack://open', 'javascript:alert(1)', 'data:text/html,x', 'vbscript:x',
  'www.example.com', 'wWw.Example.org/x', 'example.com', 'example.com/p', 'shop.example.io:8080', 'example.co.uk?x=1',
  'example[.]com', 'example (dot) com', 'example[dot]com', 'example\uFF0Ecom', 'example\u3002com', 'example\uFF61com',
  'b\u00FCcher.de', 'xn--bcher-kva.de', '\u043F\u0440\u0438\u043C\u0435\u0440.\u0440\u0444', 'paypa1.com', 'g00gle.co',
  'user@mail.example.com', '10.0.0.1', '192.168.1.1/admin',
  '<@U0TEST0001>', '<!here>', '<!channel>', '<!everyone>', '<!subteam^S0TEST0001|team>', '<https://e.com|click>', '<#C0TEST0002>',
  '@here', '@channel', '@everyone', '@Here', '&', '&amp;', '<', '>', 'R&D', 'a < b', 'x > y',
  '\u202Eevil', '\u200Bzw', '\u2066iso\u2069', '\u0007', '\u0085', '\u{E0041}', '\uFEFF', '\r\n', '\t', '\u2028',
  'Stock is low', 'Fern mug', '3.5 kg', 'v2', 'e.g.', 'i.e.',
]
const piece = fc.oneof(fc.constantFrom(...FRAGMENTS), fc.string({ maxLength: 6 }), fc.string({ unit: 'binary', maxLength: 4 }))
const mixed = fc.array(fc.tuple(piece, fc.constantFrom(' ', '\n', '')), { minLength: 1, maxLength: 14 }).map(a => a.map(([p, sep]) => p + sep).join(''))

describe('test 1: the bounds, property', () => {
  test.prop([mixed, mixed, fc.constantFrom('message' as const, 'report' as const)], { numRuns: 500 })('the hub output carries no link, mention, raw < or control, within the caps', (title, text, format) => {
    const out = boundNotice({ title, text, format }, { escape: true })
    if (!out.ok) {
      expect(['too_long', 'empty']).toContain(out.reason)
      return
    }
    for (const s of [out.title, out.text]) {
      assertClean(s)
      expect(s).not.toMatch(/[<>]/)
      expect(s).not.toMatch(/(?:^|[^&a-z])@(?:here|channel|everyone)/i)
      expect(s.replace(/&(?:amp|lt|gt);/g, '')).not.toContain('&')
    }
    expect(cp(out.title)).toBeLessThanOrEqual(TITLE_MAX)
    expect(cp(out.text)).toBeLessThanOrEqual(TEXT_MAX)
    if (format === 'message') expect(out.text).not.toContain('\n')
    expect(out.title).not.toContain('\n')
    // With a composed link, the only < and > are the app link's.
    const composed = composeSlack(out.title, out.text, { origin: 'https://app.example.com', path: '/activity' })
    expect(composed.match(/</g)?.length).toBe(1)
    expect(composed.endsWith('\n<https://app.example.com/activity|Open in Inhouse>')).toBe(true)
  })

  test.prop([mixed, mixed, fc.constantFrom('message' as const, 'report' as const)], { numRuns: 300 })('the server side is the hub side minus the escape, and the hub re-run is idempotent', (title, text, format) => {
    const server = boundNotice({ title, text, format }, { escape: false })
    const hub = boundNotice({ title, text, format }, { escape: true })
    expect(server.ok).toBe(hub.ok)
    if (!server.ok || !hub.ok) return
    assertClean(server.title)
    assertClean(server.text)
    // The hub runs steps 1 and 2 again on the server's output: same text, escaped once.
    const again = boundNotice({ title: server.title, text: server.text, format: 'report' }, { escape: true })
    expect(again).toMatchObject({ ok: true, title: hub.title, text: hub.text })
  })

  test.prop([fc.integer({ min: 1, max: 1700 }), fc.constantFrom('a', '&', '<', '\u00E9')])('length is measured after the escape and refused, never cut', (n, ch) => {
    const text = ch.repeat(n)
    const after = ch === '&' ? 5 * n : ch === '<' ? 4 * n : n
    const out = boundNotice({ title: 'T', text, format: 'report' }, { escape: false })
    if (after <= 1500) expect(out).toMatchObject({ ok: true, text })
    else expect(out).toEqual({ ok: false, reason: 'too_long' })
    expect(escapedLength(text)).toBe(after)
  })
})

describe('must remove and must keep, written by hand (review round 1)', () => {
  // Each token alone, between two words; the escape is on, as at the hub. Dropping any one rule of step 2 fails a case.
  const MUST_REMOVE = [
    'e.g.@here', 'a.b@herecom', // the escape drops the `@`: no host may be left behind
    'example\uFF0Ecom', 'example\u3002com', 'example\uFF61com', 'example\u2024com', 'example\uFE52com', // every odd dot
    'data:text/html,hi', 'tel:+15550100', 'javascript:x', 'mailto:a@b.co', 'sms:+1', 'slack:open', 'vbscript:x',
  ]
  it.each(MUST_REMOVE)('%j is removed', token => {
    expect(boundNotice({ title: 'T', text: `before ${token} after`, format: 'message' }, { escape: true })).toMatchObject({ ok: true, text: `before ${LINK_REMOVED} after` })
  })
  const MUST_KEEP = ['Raw data: 5 rows', 'Call tel: later', 'Note: mailto: is off', 'Ratio 3.5 kg', 'Version v1.2']
  it.each(MUST_KEEP)('%j stays as written', text => {
    expect(boundNotice({ title: 'T', text, format: 'message' }, { escape: true })).toMatchObject({ ok: true, text, changed: { links: false } })
  })
})

describe('literal cases, written by hand', () => {
  const cases: [string, string][] = [
    ['see https://evil.example.com/x now', `see ${LINK_REMOVED} now`],
    ['go to www.example.com', `go to ${LINK_REMOVED}`],
    ['mail me: mailto:a@b.co', `mail me: ${LINK_REMOVED}`],
    ['host example[.]com here', `host ${LINK_REMOVED} here`],
    ['host example (dot) com here', `host ${LINK_REMOVED} here`],
    ['IDN b\u00FCcher.de ok', `IDN ${LINK_REMOVED} ok`],
    ['ip 10.0.0.1 down', `ip ${LINK_REMOVED} down`],
    ['3.5 kg of R&D, a < b', '3.5 kg of R&amp;D, a &lt; b'],
    ['<!here> ping @channel', '&lt;!here&gt; ping channel'],
    ['<@U0TEST0001> and <!subteam^S01>', '&lt;@U0TEST0001&gt; and &lt;!subteam^S01&gt;'],
    ['bidi\u202Eevil zw\u200Bx tag\u{E0041}', 'bidievil zwx tag'],
    ['line1\nline2', 'line1 line2'],
  ]
  it.each(cases)('%j becomes %j (message, escaped)', (input, expected) => {
    expect(boundNotice({ title: 'T', text: input, format: 'message' }, { escape: true })).toMatchObject({ ok: true, text: expected })
  })

  it('records what changed', () => {
    expect(boundNotice({ title: 'T', text: 'x <!here> https://a.com', format: 'message' }, { escape: false })).toMatchObject({ ok: true, changed: { links: true, mentions: true } })
    expect(boundNotice({ title: 'T', text: 'plain', format: 'message' }, { escape: false })).toMatchObject({ ok: true, changed: { links: false, mentions: false } })
  })

  it('report keeps line breaks; the title never does', () => {
    expect(boundNotice({ title: 'a\nb', text: 'l1\nl2', format: 'report' }, { escape: false })).toMatchObject({ ok: true, title: 'a b', text: 'l1\nl2' })
  })

  it('empty after cleaning is refused', () => {
    expect(boundNotice({ title: '\u200B', text: 'x', format: 'message' }, { escape: false })).toEqual({ ok: false, reason: 'empty' })
  })

  it('a system body: 300 code points after the escape, refused over it', () => {
    expect(boundBody('a'.repeat(300), { escape: false, max: 300 })).toMatchObject({ ok: true })
    expect(boundBody('a'.repeat(301), { escape: false, max: 300 })).toEqual({ ok: false, reason: 'too_long' })
    expect(boundBody('&'.repeat(61), { escape: false, max: 300 })).toEqual({ ok: false, reason: 'too_long' })
  })
})

describe('the link table', () => {
  it.each([
    [{ kind: 'approval', id: 'ap_1' }, '/approvals/ap_1', { to: 'page', page: 'approvals' }],
    [{ kind: 'chat', id: 'c1' }, '/chats/c1', { to: 'chat', id: 'c1' }],
    [{ kind: 'today' }, '/', { to: 'page', page: 'today' }],
    [{ kind: 'activity' }, '/activity', { to: 'page', page: 'activity' }],
    [{ kind: 'routine', id: 'r-2' }, '/routines/r-2', { to: 'page', page: 'routines' }],
  ])('%o: Slack path %s, bell %o', (link, path, bell) => {
    expect(linkPath(link)).toBe(path)
    expect(bellLink(link)).toEqual(bell)
  })

  it.each([{ kind: 'chat' }, { kind: 'chat', id: '../x' }, { kind: 'chat', id: 'a'.repeat(65) }, { kind: 'today', id: 'x' }, { kind: 'url', id: 'x' }, null, 'today'])('%o is unusable: no path, the bell gets Today', link => {
    expect(checkLink(link)).toBeNull()
    expect(linkPath(link)).toBeNull()
    expect(bellLink(link)).toEqual({ to: 'page', page: 'today' })
  })
})
