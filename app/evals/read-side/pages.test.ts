import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { READ_SIDE_CASES } from './cases.ts'
import { renderPage } from './pages.ts'

describe('eval page fixtures', () => {
  const web = READ_SIDE_CASES.filter(c => c.source === 'web_page')
  it('has a page file for each web page case, equal to its render and holding the canary', () => {
    expect(web).toHaveLength(12)
    for (const c of web) {
      const file = readFileSync(new URL(`./pages/${c.id}/index.html`, import.meta.url), 'utf8')
      expect(file).toBe(renderPage(c))
      expect(file).toContain(c.canary)
    }
  })
})
