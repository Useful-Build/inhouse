// The "Websites it may open" field (`t:webfetch`, a host list). Ways it could fail, written first:
//  - a value the server refuses is saved from here (a URL, a single word, an IP address, more than 50 hosts), so the save fails after it showed;
//  - a tidy-up that changes what the person meant (case, commas, repeats) or keeps a blank line the server refuses;
//  - an empty list refused: empty is valid and means any public website (design 4.9).
// The expected values are written out here.
import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
const { checkField } = await import('./content')
const { readParts } = await import('./read-text')

describe('checkField for a host list', () => {
  it.each([
    ['one host a line, lowercased', 'Example.com\nShop.Example.org', 'example.com\nshop.example.org'],
    ['commas, spaces and blank lines as line breaks', 'a.example.com, b.example.com  c.example.com\n\n', 'a.example.com\nb.example.com\nc.example.com'],
    ['a host written twice once', 'a.example.com\nA.example.com', 'a.example.com'],
    ['nothing at all: any public website', '   \n ', ''],
  ])('%s', (_n, raw, saved) => { expect(checkField('hosts', raw)).toEqual({ value: saved }) })

  it.each([
    ['a URL', 'https://example.com'], ['a single word', 'localhost'], ['an IP address', '10.0.0.1'], ['a hex address', '0x7f.0x1'],
    ['a path', 'example.com/shop'], ['an underscore in a name', 'exa_mple.com'],
  ])('refuses %s', (_n, raw) => { expect(checkField('hosts', raw)).toHaveProperty('error') })

  it('takes 50 hosts and refuses 51', () => {
    const hosts = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.com`).join('\n')
    expect(checkField('hosts', hosts(50))).toEqual({ value: hosts(50) })
    expect(checkField('hosts', hosts(51))).toHaveProperty('error')
  })
})

describe('the read-only text of the row (a phone)', () => {
  const row = (value: string) => ({ title: 't', desc: '', kind: 'text' as const, value, need: 0, type: 'hosts' as const })
  it('lists the sites on one line, and says "any" for none', () => {
    expect(readParts(row('a.example.com\nb.example.com'), false)).toBe('a.example.com, b.example.com')
    expect(readParts(row(''), false)).toBe('Any public website')
  })
})
