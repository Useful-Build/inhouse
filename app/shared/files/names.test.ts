// The shared file-name rule (both the Worker and the runner hold it). Literal good and bad names, written apart from the
// rule. Ways it can fail: a control character (NUL, C0, DEL, C1) or a segment over 255 UTF-8 bytes passes; a dot
// segment, `#`, `\` or an unpaired surrogate passes; an ordinary name (spaces, accents, emoji, dots inside) is refused.
import { describe, expect, it } from 'vitest'
import { badFileName } from './names.ts'

describe('badFileName', () => {
  it('refuses these', () => {
    const bad = [
      'a\u0000b.txt', 'line\nbreak.txt', 'tab\there.csv', 'esc\u001b[31m.txt', 'del\u007f.txt', 'c1\u0085.txt', 'c1\u009f.txt',
      'x'.repeat(256), `outputs/${'é'.repeat(128)}`, // 256 bytes in one segment
      '', '.', '..', 'outputs/', '/abs', 'a//b', 'outputs/../x', 'a#b', 'a\\b', 'bad\ud800.txt',
    ]
    for (const name of bad) expect(badFileName(name), JSON.stringify(name)).toBe(true)
  })
  it('accepts these', () => {
    const good = [
      'report.pdf', 'outputs/sub dir/t1.csv', 'Résumé final.docx', '数据.xlsx', 'emoji 📊.md', 'a.b.c.txt', '.hidden', 'x'.repeat(255),
      `outputs/${'é'.repeat(127)}a`, // 255 bytes
    ]
    for (const name of good) expect(badFileName(name), JSON.stringify(name)).toBe(false)
  })
})
