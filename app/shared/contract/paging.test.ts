// Paging (p2-design.md section 5). Ways it can fail, written down first:
//  1. a limit outside 1 to 100 (or not a whole number) parses, so one request reads the whole table;
//  2. no limit doesn't give the default 50;
//  3. a cursor (asked for or served) that isn't base64url, or is unbounded, parses.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CursorSchema, PageRequestSchema, pageOf } from './paging.ts'

const ok = (v: unknown) => PageRequestSchema.safeParse(v).success

describe('the request', () => {
  it('refuses a limit of 0, 101, a fraction or text (failure 1)', () => {
    for (const limit of [0, 101, '0', '101', 2.5, 'ten', '']) expect(ok({ limit }), String(limit)).toBe(false)
  })
  test.prop([fc.integer({ min: 1, max: 100 })])('takes every limit from 1 to 100, as a number or as query text', n => {
    expect(PageRequestSchema.parse({ limit: n }).limit).toBe(n)
    expect(PageRequestSchema.parse({ limit: String(n) }).limit).toBe(n)
  })
  it('defaults the limit to 50 (failure 2)', () => expect(PageRequestSchema.parse({})).toEqual({ limit: 50 }))
  it("refuses a cursor that isn't base64url, an empty or an overlong one, and an unknown field (failure 3)", () => {
    for (const cursor of ['abc!', '', 'a=', 'a b', 'a'.repeat(513)]) expect(ok({ cursor }), cursor).toBe(false)
    expect(ok({ cursor: 'eyJpZCI6NDJ9' })).toBe(true)
    expect(ok({ limit: 5, sort: 'name' })).toBe(false)
  })
})

describe('the page (failure 3)', () => {
  const page = pageOf(z.number())
  it('serves a base64url cursor or null, nothing else', () => {
    expect(page.safeParse({ items: [1], nextCursor: 'eyJpZCI6NDJ9' }).success).toBe(true)
    expect(page.safeParse({ items: [], nextCursor: null }).success).toBe(true)
    for (const nextCursor of ['abc!', '', 'a'.repeat(513)]) expect(page.safeParse({ items: [], nextCursor }).success).toBe(false)
  })
  test.prop([fc.uint8Array({ minLength: 1, maxLength: 256 })])('takes any base64url key of up to 256 bytes', bytes => {
    const b64url = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(CursorSchema.safeParse(b64url).success).toBe(true)
  })
})
