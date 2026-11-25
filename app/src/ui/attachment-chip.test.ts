// The attachment chip's Download button, rendered to markup (no DOM library in this repo, so the test reads what React
// writes). Ways it could break, written down before the code:
//  - the button is missing, or its accessible name isn't `Download <file name>` (a screen reader and the e2e spec find it by it);
//  - it shows on a chip with nothing to fetch (the composer's chip before sending, a rejected file);
//  - it stays enabled while a download runs (a second click saves the file twice) or isn't marked busy;
//  - it takes the place of Remove or Dismiss, which the composer's chip still needs;
//  - the chip's state (done, processing while a download runs, error for a rejected file) doesn't reach the base Attachment,
//    or a rejected chip loses `data-rejected`, which the composer spec and the alert region rely on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, test, vi } from 'vitest'

// The UI store reads the browser at import (window, storage, matchMedia): the smallest stand-ins that let it load under Node.
vi.hoisted(() => {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 }
  const g = globalThis as Record<string, unknown>
  g.window = Object.assign(globalThis, { addEventListener: () => undefined, removeEventListener: () => undefined, matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }), localStorage: storage, sessionStorage: storage })
})

let TooltipProvider: typeof import('@/components/ui/tooltip').TooltipProvider
let AttachmentChip: typeof import('./chrome').AttachmentChip
beforeAll(async () => {
  ;({ TooltipProvider } = await import('@/components/ui/tooltip'))
  ;({ AttachmentChip } = await import('./chrome'))
})

type Props = Parameters<typeof import('./chrome').AttachmentChip>[0]
const html = (p: Partial<Props>) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(AttachmentChip, { icon: 'description', name: 'orders.csv', meta: '4 KB', ...p })))
const buttons = (h: string) => [...h.matchAll(/<button\b[^>]*>/g)].map(m => m[0])

describe('AttachmentChip download', () => {
  test('a downloadable chip has one button named Download <name>', () => {
    const b = buttons(html({ onDownload: () => undefined }))
    expect(b).toHaveLength(1)
    expect(b[0]).toContain('aria-label="Download orders.csv"')
    expect(b[0]).not.toMatch(/\sdisabled(=|\s|>)/)
  })

  test('names the file, whatever it is called', () => {
    expect(buttons(html({ name: 'Q1 "final" & more.pdf', onDownload: () => undefined }))[0]).toContain('aria-label="Download Q1 &quot;final&quot; &amp; more.pdf"')
  })

  test('is disabled and busy while downloading', () => {
    const b = buttons(html({ onDownload: () => undefined, downloading: true }))[0]!
    expect(b).toMatch(/\sdisabled(=|\s|>)/)
    expect(b).toContain('aria-busy="true"')
  })

  test('a chip with nothing to download has no button', () => {
    expect(buttons(html({}))).toHaveLength(0)
    expect(buttons(html({ error: true }))).toHaveLength(0)
  })

  test('the composer chip keeps Remove, and a downloadable one never loses its own button to it', () => {
    expect(buttons(html({ onRemove: () => undefined }))[0]).toContain('aria-label="Remove orders.csv"')
    expect(buttons(html({ onRemove: () => undefined, onDownload: () => undefined })).map(b => /aria-label="([^"]*)"/.exec(b)?.[1])).toEqual(['Download orders.csv', 'Remove orders.csv'])
  })
})

describe('AttachmentChip state', () => {
  const state = (h: string) => /data-state="([^"]*)"/.exec(h)?.[1]
  test('is done, processing while downloading, and error for a rejected file', () => {
    expect(state(html({}))).toBe('done')
    expect(state(html({ onDownload: () => undefined, downloading: true }))).toBe('processing')
    expect(state(html({ error: true }))).toBe('error')
  })

  test('only a rejected chip is marked data-rejected', () => {
    expect(html({ error: true, onRemove: () => undefined })).toContain('data-rejected')
    expect(html({ onRemove: () => undefined })).not.toContain('data-rejected')
  })
})
