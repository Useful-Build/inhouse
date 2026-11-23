import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fc, test } from '@fast-check/vitest'
import { expect, vi } from 'vitest'
import { Markdown } from './Markdown'

vi.mock('../../ui', () => ({ IconButton: () => null }))
vi.mock('./copy', () => ({ copyText: () => undefined }))

const html = (text: string, linkHosts: string[] = []) => renderToStaticMarkup(createElement(Markdown, { text, linkHosts }))
const host = fc.stringMatching(/^[a-z][a-z0-9]{0,15}$/)
const path = fc.stringMatching(/^[a-z0-9/_-]{0,30}$/)
const markup = (url: string) => `[Report](${url}) <${url}> ${url} ![Chart](${url})`

test.prop([host, path])('unlisted hosts never produce browser destinations, even with a listed hostname prefix', (name, suffix) => {
  const listed = `${name}.example.test`
  const url = `https://${listed}.other.test/${suffix}?date=2026-11-23`
  const out = html(markup(url), [listed])
  expect(out).not.toMatch(/<(?:a|img)\b/)
  expect(out).toContain('Report')
  expect(out).toContain(url)
  expect(out).toContain('Chart')
})

test.prop([host, path])('a listed host can render links and images in each supported form', (name, suffix) => {
  const listed = `${name}.example.test`
  const url = `https://${listed}/${suffix}?date=2026-11-23`
  const out = html(markup(url), [listed])
  expect(out.match(/<a\b/g)).toHaveLength(3)
  expect(out.match(/href="/g)).toHaveLength(3)
  expect(out).toContain(`<img src="${url}" alt="Chart"`)
  expect(out).toMatch(/referrerpolicy="no-referrer"/i)
})

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
