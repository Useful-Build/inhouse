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
