// The product entry's clock. Vitest aliases `@client` to the demo entry, so this imports the product entry itself.
// Ways it could break, written down first: `now()` reads the demo clock (Mon, Nov 16, 2026, from 8:00 AM) or a fixed
// value instead of the real clock; it stops following the real clock once read; the product entry carries demo controls.
import { fc, test } from '@fast-check/vitest'
import { afterEach, describe, expect, vi } from 'vitest'
import product from './client.product'
import { HttpAgent } from './http/client'

/** The demo's day, as a local date: the product clock must never land on it unless the real clock does. */
const DEMO_DAY = new Date(2026, 10, 16).toDateString()

afterEach(() => { vi.useRealTimers() })

describe('the product entry', () => {
  test('is the HTTP stub with no demo controls', () => {
    expect(product.agent).toBeInstanceOf(HttpAgent)
    expect(product.demo).toBeNull()
  })

  test('now() is the real clock on a date that is not the demo\'s, and moves on with it', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const real = Date.UTC(2031, 2, 5, 12, 34, 56)
    vi.setSystemTime(real)
    expect(product.now()).toBe(real)
    expect(new Date(product.now()).toDateString()).not.toBe(DEMO_DAY)
    vi.setSystemTime(real + 90_000)
    expect(product.now()).toBe(real + 90_000)
  })

  // Any real time from 2000 to 2100, the demo's day included: now() is exactly it.
  test.prop([fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) })])('now() returns the real clock at any time', t => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(t)
    expect(product.now()).toBe(t)
  })
})
