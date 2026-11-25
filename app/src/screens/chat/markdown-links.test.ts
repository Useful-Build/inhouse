import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { Markdown } from './markdown/renderer'

vi.mock('../../ui', () => ({ IconButton: () => null }))
vi.mock('./copy', () => ({ copyText: () => undefined }))

const html = (text: string, linkHosts: string[] = []) => renderToStaticMarkup(createElement(Markdown, { text, linkHosts }))
const markup = (url: string) => `[Report](${url}) <${url}> ${url} ![Chart](${url})`

test('external destinations are off by default and in-app routes stay clickable', () => {
  const out = html(`[Tools](#/tools/shopify) ${markup('https://docs.example.test/')}`)
  expect(out.match(/<a\b/g)).toHaveLength(1)
  expect(out).toContain('href="#/tools/shopify"')
  expect(out).not.toContain('<img')
})

test('unapproved schemes, ports, credentials and subdomains stay text', () => {
  const listed = 'docs.example.test'
  for (const url of [
    'javascript:void(0)', 'mailto:test@example.test', '//docs.example.test/',
    'http://docs.example.test/', 'https://docs.example.test:444/', 'https://user@docs.example.test/',
    'https://sub.docs.example.test/', 'https://docs.example.test@unlisted.example.test/',
  ]) {
    expect(html(`[Report](${url}) ![Chart](${url})`, [listed])).not.toMatch(/<(?:a|img)\b/)
  }
})

test('validates the destination of named links and images, including angle-bracket destinations and URL labels', () => {
  const url = 'https://docs.example.test/'
  const out = html(`[${url}](<https://unlisted.example.test/>) ![Chart](<https://unlisted.example.test/>) [Report](<${url}>)`, ['docs.example.test'])
  expect(out.match(/<a\b/g)).toHaveLength(1)
  expect(out).toContain('>Report</a>')
  expect(out).not.toContain('<img')
})

test.each([
  '<https://docs.example.test/page',
  '<https://docs.example.test.',
])('an unclosed angle destination is no link or image of its own (%s)', dest => {
  // CommonMark shows it as written; the only link is the bare listed address inside it (a listed host may be linked bare).
  const out = html(`[Report](${dest}) ![Chart](${dest})`, ['docs.example.test'])
  expect(out).not.toContain('<img')
  expect(out).toContain('[Report](&lt;')
  for (const m of out.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)) {
    expect(m[1]).toMatch(/^https:\/\/docs\.example\.test\//)
    expect(m[2]).toMatch(/^https:\/\/docs\.example\.test/)
  }
})

test.each([
  ['https://docs.example.test', 'https://docs.example.test/'],
  ['https://docs.example.test/guide', 'https://docs.example.test/guide'],
  ['https://docs.example.test/wiki/Foo_(bar)', 'https://docs.example.test/wiki/Foo_(bar)'],
])('keeps prose parentheses outside the bare URL %s', (url, href) => {
  const out = html(`See ((${url})).`, ['docs.example.test'])
  expect(out).toContain(`href="${href}"`)
  expect(out).toContain(`>${url}</a>)).`)
})

test('preserves balanced parentheses in a bare URL', () => {
  const url = 'https://en.wikipedia.org/wiki/Foo_(bar)'
  const out = html(url, ['en.wikipedia.org'])
  expect(out).toContain(`href="${url}"`)
  expect(out).toContain(`>${url}</a>`)
})

test.each([
  ['HTTPS://DOCS.Example.Test/Guide', 'docs.example.test', 'https://docs.example.test/Guide'],
  ['https://bücher.example.test/Guide', 'xn--bcher-kva.example.test', 'https://xn--bcher-kva.example.test/Guide'],
  ['https://xn--bcher-kva.example.test/Guide', 'xn--bcher-kva.example.test', 'https://xn--bcher-kva.example.test/Guide'],
])('matches the canonical hostname for %s', (url, host, href) => {
  expect(html(`[Report](${url})`, [host])).toContain(`href="${href}"`)
})

test('leaves trailing-dot hostnames as text', () => {
  const url = 'https://docs.example.test./guide'
  expect(html(`[Report](${url}) <${url}> ${url}`, ['docs.example.test']))
    .toContain(`>Report ${url} ${url}</p>`)
})

test('leaves data URLs as text', () => {
  const url = 'data:text/plain,report'
  expect(html(`[Report](${url}) ![Chart](${url}) ${url}`, ['docs.example.test']))
    .toContain(`>Report Chart ${url}</p>`)
})

test('escapes raw HTML', () => {
  const out = html('<img src=x onerror=alert(1)> <script>alert(1)</script>', ['docs.example.test'])
  expect(out).toContain('&lt;img src=x onerror=alert(1)&gt; &lt;script&gt;alert(1)&lt;/script&gt;')
  expect(out).not.toMatch(/<(?:img|script)\b/)
})
