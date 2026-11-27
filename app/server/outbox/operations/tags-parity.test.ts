// #491 (Stage 1 M3-S2): the hub's tag rule is exactly the server's, so a tag list the server resolves and a person
// approves is never refused (or, worse, changed) at the hub, and one the server refuses never passes the hub either. It
// used to differ three ways: the hub let format characters (bidi, zero-width) through, trimmed surrounding space instead
// of refusing it, and took "VIP" and "vip" as two tags. A differential property over both schemas.
import { fc, test } from '@fast-check/vitest'
import { beforeAll, describe, expect, it } from 'vitest'
import { TagsSchema } from './shopify-order-tags.ts'

// Loaded at run time, as write-safety.property.test.ts loads the hub: the hub's imports are extensionless (it builds with
// `bundler` resolution), so a static import would pull its files into the app's `nodenext` typecheck.
type SafeParse = { safeParse(v: unknown): { success: true; data: unknown } | { success: false } }
const HUB_TAGS: string = '../../../hub/connectors/shopify/write/ops/tags.ts'
let ShopifyTagsSchema!: SafeParse
beforeAll(async () => {
  const mod = (await import(/* @vite-ignore */ HUB_TAGS)) as { ShopifyTagsSchema?: SafeParse }
  if (!mod.ShopifyTagsSchema) throw new Error('the hub no longer exports ShopifyTagsSchema')
  ShopifyTagsSchema = mod.ShopifyTagsSchema
})

const tagChars = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom('a', 'B', 'v', 'I', 'P', '1', '-', '_', ' ', 'é') },
  { weight: 1, arbitrary: fc.constantFrom(',', '​', '‮', '­', '\t', '\n', '\u0085', '\u007f', '﻿', '😀') },
)
const tag = fc.array(tagChars, { minLength: 0, maxLength: 42 }).map(cs => cs.join(''))

describe('the hub and the server take the same tags (#491)', () => {
  test.prop([fc.array(tag, { minLength: 0, maxLength: 6 })], { numRuns: 500 })('agree on every tag list', tags => {
    const server = TagsSchema.safeParse(tags)
    const hub = ShopifyTagsSchema.safeParse(tags)
    expect(hub.success, JSON.stringify(tags)).toBe(server.success)
    // Whatever passes is passed on as it is: nothing trimmed or changed.
    if (hub.success) expect(hub.data).toEqual(tags)
  })

  it('refuses the three old differences at both ends', () => {
    for (const tags of [['v​ip'], ['a‮b'], [' vip'], ['vip '], ['VIP', 'vip']]) {
      expect(TagsSchema.safeParse(tags).success, JSON.stringify(tags)).toBe(false)
      expect(ShopifyTagsSchema.safeParse(tags).success, JSON.stringify(tags)).toBe(false)
    }
  })
})
