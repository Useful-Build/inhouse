// The "Websites it may open" field (`t:webfetch`, a host list). Ways it could fail, written first:
//  - a value the server refuses is saved from here (a URL, a single word, an IP address, more than 50 hosts), so the save fails after it showed;
//  - a tidy-up that changes what the person meant (case, commas, repeats) or keeps a blank line the server refuses;
//  - an empty list refused: empty is valid and means no website (P8a S, #744: a saved empty list blocks, only a brand that
//    never saved a list is open);
//  - (M3-J) the row's words or read-only text disagree with the server's `webFetchMode`: "Any public website" while the
//    server reads `list` (a saved empty list, the mode set to `list`, an invalid mode: #744, #745), or the reverse.
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
    ['nothing at all: an empty list, which blocks every website', '   \n ', ''],
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
  const row = (value: string, display?: string) => ({ title: 't', desc: '', kind: 'text' as const, value, need: 0, type: 'hosts' as const, ...(display ? { display } : {}) })
  it('lists the sites on one line; none is "No websites" unless the row says the list doesn\'t decide', () => {
    expect(readParts(row('a.example.com\nb.example.com'), false)).toBe('a.example.com, b.example.com')
    expect(readParts(row(''), false)).toBe('No websites')
    expect(readParts(row('', 'Any public website'), false)).toBe('Any public website')
  })
})

describe('the web rows\' words follow the fetch mode (M3-J)', () => {
  it('no mode: no saved list is open, a saved list (even empty) blocks all but its hosts; `list`: the list; `open`: unused; an invalid mode is `list`', async () => {
    const { webFetchWords } = await import('./content')
    const { webFetchMode } = await import('../../../shared/contract/settings-table')
    const modes = [undefined, null, 'list', 'open', 'OPEN', 'any', true, 0, ''] as const
    const lists = [undefined, null, '', 'a.example.com', 'not a list!', 7] as const
    for (const mode of modes) for (const hosts of lists) {
      const w = webFetchWords(mode, hosts)
      const open = webFetchMode(mode, hosts) === 'open'
      const at = `${String(mode)} ${String(hosts)}`
      // Whatever the words, read-only says "Any public website" exactly when the server reads it as open.
      expect(w.readOnly === 'Any public website', at).toBe(open)
      // "Leave empty to block all websites" whenever the list is what decides; never a promise that empty is open.
      expect(/Leave empty to block all websites/.test(w.list), at).toBe(!open)
      expect(/Leave empty to allow/.test(w.list), at).toBe(false)
    }
  })

  it('the words in each case', async () => {
    const { webFetchWords } = await import('./content')
    // No mode, no saved list (#744): open, and saving it empty says it blocks.
    expect(webFetchWords(undefined, undefined).list).toBe('Until a list is saved, any public website is allowed. Enter one website name per line to allow only those. Saving it empty blocks all websites.')
    // A saved empty list with no mode blocks (the screen's promise), not "any public website".
    expect(webFetchWords(undefined, '')).toEqual({ read: 'Let your Inhouse agent open the websites listed below. Off blocks them all.', list: 'Enter one website name per line. Leave empty to block all websites.' })
    // An invalid stored mode is what the server reads: the list (#745).
    expect(webFetchWords('any', '')).toEqual(webFetchWords('list', ''))
    expect(webFetchWords('any', undefined).readOnly).toBeUndefined()
  })
})
