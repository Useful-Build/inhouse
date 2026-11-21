// The per-case hub config and the shop pattern (runner review round 2, H1 and L1). Ways it can fail, written down first:
//  1. the config isn't changed (or the wrong var is) so wrangler prints another shop, or the replacement breaks the file;
//  2. the pattern matches a longer shop (`late-orders` in `late-orders-red`), or wrangler's "(hidden)" counts as shown;
//  3. the restart command doesn't take the config's path, or a path with a quote breaks the command.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { META } from './expected.ts'
import { commandFor, hubConfigFor } from './hubconfig.ts'
import { DEFAULT_SHOP_PATTERN, shopShownBy } from './restart.ts'

const CONFIG = readFileSync(new URL('../../wrangler.hub.test.jsonc', import.meta.url), 'utf8')

describe('the per-case hub config', () => {
  it('changes only the SHOPIFY_SHOP var of the real test hub config', () => {
    const out = hubConfigFor(CONFIG, 'example-mc-late-orders')
    expect(out).toContain('"SHOPIFY_SHOP": "example-mc-late-orders"')
    expect(out).not.toContain('example-fixture"')
    const was = CONFIG.split('\n')
    const now = out.split('\n')
    expect(now).toHaveLength(was.length)
    expect(was.filter((l, i) => l !== now[i])).toHaveLength(1)
  })
  it('refuses a config with no such var or two, and a name that is not a shop handle', () => {
    expect(() => hubConfigFor('{ "vars": {} }', 'example-mc-a')).toThrow(/no single/)
    expect(() => hubConfigFor('{ "SHOPIFY_SHOP": "a", "x": { "SHOPIFY_SHOP": "b" } }', 'example-mc-a')).toThrow(/no single/)
    for (const bad of ['', 'A', 'a b', 'a"b', '../x', 'a\n']) expect(() => hubConfigFor(CONFIG, bad), bad).toThrow(/shop handle/)
  })
  it('every case host is a shop handle the config accepts', () => {
    for (const c of META) expect(() => hubConfigFor(CONFIG, `example-mc-${c.id}`), c.id).not.toThrow()
  })
  it('the restart command must use {hubConfig}, and gets the path quoted', () => {
    expect(() => commandFor('npx wrangler dev', '/a/b.jsonc')).toThrow(/{hubConfig}/)
    expect(commandFor('wrangler dev -c w.jsonc -c {hubConfig} --x', '/a/b.jsonc')).toBe("wrangler dev -c w.jsonc -c '/a/b.jsonc' --x")
    expect(commandFor('w {hubConfig}', "/a/it's.jsonc")).toBe("w '/a/it'\\''s.jsonc'")
  })
})

describe('the shop pattern', () => {
  const shown = shopShownBy(DEFAULT_SHOP_PATTERN)
  const line = (shop: string) => `Your Worker has access to the following bindings:\nenv.SHOPIFY_SHOP ("${shop}")    Environment Variable    local`
  it("matches wrangler's line for the shop", () => {
    expect(shown(line('example-mc-late-orders'), 'example-mc-late-orders')).toBe(true)
  })
  it('does not match a longer shop, another shop, or a hidden value', () => {
    expect(shown(line('example-mc-late-orders-red'), 'example-mc-late-orders')).toBe(false)
    expect(shown(line('example-mc-late-orders'), 'example-mc-late-orders-red')).toBe(false)
    expect(shown(line('example-fixture'), 'example-mc-late-orders')).toBe(false)
    expect(shown('env.SHOPIFY_SHOP ("(hidden)")    Environment Variable    local', 'example-mc-late-orders')).toBe(false)
    expect(shown('nothing yet', 'example-mc-late-orders')).toBe(false)
  })
  it("no case's line matches another case's shop", () => {
    for (const a of META) for (const b of META) if (a.id !== b.id) expect(shown(line(`example-mc-${b.id}`), `example-mc-${a.id}`), `${a.id} in ${b.id}`).toBe(false)
  })
  it('a custom pattern takes the shop where {shop} is, escaped', () => {
    expect(shopShownBy('x={shop};')('x=a.b;', 'a.b')).toBe(true)
    expect(shopShownBy('x={shop};')('x=aXb;', 'a.b')).toBe(false)
  })
})
