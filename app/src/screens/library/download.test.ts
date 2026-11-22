// The Library's downloads. Ways it could fail, written down first: a link without `download` lets a 404 or a sign-in
// page replace the app (the browser navigates to it); one file's link stops the rest; a link drops the server's name.
import { describe, expect, test } from 'vitest'
import { downloadAll } from './download'
import type { DownloadLink } from './download'

describe('downloadAll', () => {
  test('every URL gets its own link with download set (empty: the server names the file), clicked once', () => {
    const made: (DownloadLink & { clicks: number })[] = []
    const link = () => { const a = { href: '', download: 'unset', rel: '', clicks: 0, click() { this.clicks++ } }; made.push(a); return a }
    downloadAll(['/api/library/f_a/download', '/api/library/f_b/download'], link)
    expect(made.map(a => [a.href, a.download, a.rel, a.clicks])).toEqual([
      ['/api/library/f_a/download', '', 'noopener', 1],
      ['/api/library/f_b/download', '', 'noopener', 1],
    ])
  })
})
