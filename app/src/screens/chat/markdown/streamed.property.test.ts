// What must hold for any answer as it streams in. Ways it could break, written first: a half-written piece (an open
// fence, a bold with no end, a table with no separator yet, a link cut mid-address) makes the renderer throw, so the
// chat stops mid-answer; a link, image or address the text should not have is made clickable or loaded (a port, a
// credential, a sibling subdomain, javascript:, mailto:, data:) at any point of the stream; or the finished text looks
// different while it is live than once it is done, so the answer jumps when the stream ends.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fc, test } from '@fast-check/vitest'
import { expect, vi } from 'vitest'
import { Markdown } from './renderer'

vi.mock('../../../ui', () => ({ IconButton: () => null }))
vi.mock('../copy', () => ({ copyText: () => undefined }))

const LISTED = ['docs.example.test', 'api.example.test']
const render = (text: string, linkHosts: string[], live: boolean) => renderToStaticMarkup(createElement(Markdown, { text, linkHosts, live }))

// ---------- documents ----------
const word = fc.stringMatching(/^[a-z]{1,8}$/)
const url = fc.constantFrom(
  'https://docs.example.test/guide', 'https://docs.example.test', 'https://api.example.test/v1?x=1', 'https://other.example.test/page',
  'https://sub.docs.example.test/', 'https://docs.example.test.evil.test/', 'https://docs.example.test:444/', 'https://user@docs.example.test/',
  'https://docs.example.test@evil.test/', 'http://docs.example.test/', 'HTTPS://DOCS.EXAMPLE.TEST/Guide', '//docs.example.test/',
  'javascript:alert(1)', 'mailto:a@b.test', 'data:text/html,hi', '#/tools/shopify', '#note', '/relative',
)
const inline = fc.oneof(
  word, word.map(w => `**${w}**`), word.map(w => `*${w}*`), word.map(w => `_${w}_`), word.map(w => `\`${w}\``),
  fc.tuple(word, url).map(([w, u]) => `[${w}](${u})`), fc.tuple(word, url).map(([w, u]) => `[${w}](<${u}>)`),
  fc.tuple(word, url).map(([w, u]) => `![${w}](${u})`), url.map(u => `<${u}>`), url, fc.constant('www.docs.example.test/x'), fc.constant('a@b.test'),
)
const text = fc.array(inline, { minLength: 1, maxLength: 8 }).map(a => a.join(' '))
const cell = fc.oneof(word, fc.tuple(word, url).map(([w, u]) => `[${w}](${u})`))
const table = fc.tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 })).chain(([cols, rows]) => {
  const row = fc.array(cell, { minLength: cols, maxLength: cols + 1 }).map(c => `| ${c.join(' | ')} |`)
  return fc.tuple(row, fc.array(row, { minLength: 1, maxLength: rows })).map(([head, body]) => [head, `|${' --- |'.repeat(cols)}`, ...body].join('\n'))
})
const block = fc.oneof(
  text, text.map(t => `# ${t}`), text.map(t => `### ${t}`), text.map(t => `> ${t}`), fc.constant('---'),
  fc.array(text, { minLength: 1, maxLength: 4 }).map(a => a.map(t => `- ${t}`).join('\n')),
  fc.array(text, { minLength: 1, maxLength: 4 }).map(a => a.map((t, i) => `${i + 1}. ${t}`).join('\n')),
  fc.array(fc.stringMatching(/^[a-z =()|#*_`<>-]{0,20}$/), { maxLength: 5 }).map(a => ['```sql', ...a, '```'].join('\n')),
  table,
)
const doc = fc.array(block, { minLength: 1, maxLength: 6 }).map(a => a.join('\n\n') + '\n')
/** Up to `n` prefixes of `s`, evenly spaced, and `s` itself. */
const prefixes = (s: string, n = 24) => Array.from({ length: Math.min(n, s.length) }, (_, i) => s.slice(0, Math.ceil(((i + 1) * s.length) / n))).concat(s)

const destinations = (html: string) => [...html.matchAll(/\s(href|src)="([^"]*)"/g)].map(m => ({ attr: m[1], value: m[2] }))

/** Every link and image address in `html` is an in-app route or a listed host over https, with no port or credentials. */
function expectPolicy(html: string, hosts: string[]) {
  expect(html).not.toMatch(/<script|data-streamdown/i)
  for (const { attr, value } of destinations(html)) {
    if (attr === 'href' && value.startsWith('#/')) continue
    const u = new URL(value)
    expect(u.protocol, value).toBe('https:')
    expect(hosts, value).toContain(u.hostname)
    expect(u.port + u.username + u.password, value).toBe('')
  }
}

test.prop([doc], { numRuns: 40 })('any prefix of a document renders while it is live, and with no hosts listed nothing leaves the app', d => {
  for (const p of prefixes(d)) {
    const out = render(p, [], true)
    expectPolicy(out, [])
    expect(out, p).not.toContain('<img')
  }
})

test.prop([doc], { numRuns: 40 })('any prefix renders with hosts listed, live or not, and only listed hosts are reached', d => {
  for (const p of prefixes(d)) {
    expectPolicy(render(p, LISTED, true), LISTED)
    expectPolicy(render(p, LISTED, false), LISTED)
  }
})

test.prop([doc], { numRuns: 60 })('the finished text looks the same live as done, so the answer does not jump when the stream ends', d => {
  expect(render(d, [], true)).toBe(render(d, [], false))
})
