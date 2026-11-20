import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

// The hub has no HTTP surface: the default export answers 404 for every method and path.
describe('the default export', () => {
  const paths = ['/', '/mcp', `/${crypto.randomUUID()}`]
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    for (const path of paths) {
      it(`${method} ${path} is 404`, async () => {
        const res = await exports.default.fetch(new Request(`https://hub.example${path}`, { method }))
        expect(res.status).toBe(404)
        expect(res.headers.get('Cache-Control')).toBe('no-store')
        expect(await res.json()).toEqual({ error: 'not_found' })
      })
    }
  }
})
