// The zip header walk (ZipWalk) fed in pieces. Ways it can fail, written first:
//  1. a header that straddles two pieces (in its 30 fixed bytes or its name) is missed or misread;
//  2. an entry's data is taken for a header, or a header is skipped;
//  3. the walk goes on past a bit-3 entry or a non-header.
// Oracle: a reference written here from the entry list itself (which names come in, in order), sharing no code with the
// walk: `[Content_Types].xml` seen, the first Office folder, stopped at the first bit-3 entry.
import { fc, test } from '@fast-check/vitest'
import { expect } from 'vitest'
import { ZipWalk, sniffType } from './sniff.ts'

const NAMES = ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'xl/workbook.xml', 'word/document.xml', 'ppt/presentation.xml', 'media/a.png', 'é/ü.xml']
const FOLDERS: [string, string][] = [
  ['xl/', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['word/', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['ppt/', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]

interface Entry { name: string; size: number; bit3: boolean }

function zipOf(entries: Entry[]): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const e of entries) {
    const n = enc.encode(e.name)
    const h = new DataView(new ArrayBuffer(30))
    h.setUint32(0, 0x04034b50, true)
    h.setUint16(6, e.bit3 ? 0x08 : 0, true)
    h.setUint32(18, e.size, true)
    h.setUint16(26, n.length, true)
    // Data that looks like a header, to catch a walk that reads data as headers.
    const data = new Uint8Array(e.size).map((_, i) => [0x50, 0x4b, 0x03, 0x04][i % 4]!)
    parts.push(new Uint8Array(h.buffer), n, data)
  }
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function reference(entries: Entry[]) {
  let contentTypes = false
  let folder: string | null = null
  let stopped = false
  for (const e of entries) {
    if (e.name === '[Content_Types].xml') contentTypes = true
    if (folder === null) folder = FOLDERS.find(([f]) => e.name.startsWith(f))?.[1] ?? null
    if (e.bit3) {
      stopped = true
      break
    }
  }
  return { contentTypes, folder, stopped }
}

const entries = fc.array(fc.record({ name: fc.constantFrom(...NAMES), size: fc.nat({ max: 200 }), bit3: fc.oneof({ weight: 9, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }) }), { maxLength: 8 })
test.prop([entries, fc.array(fc.integer({ min: 1, max: 64 }), { minLength: 1, maxLength: 20 })])(
  'fed in pieces of any size, the walk says what the entry list says (failures 1 to 3)',
  (list, sizes) => {
    const bytes = zipOf(list)
    const walk = new ZipWalk()
    let at = 0
    for (let k = 0; at < bytes.length; k++) {
      const size = sizes[k % sizes.length]!
      walk.push(bytes.subarray(at, at + size))
      at += size
    }
    const ref = reference(list)
    expect({ contentTypes: walk.contentTypes, folder: walk.folder, stopped: walk.stopped }).toEqual(ref)
    // The whole-buffer sniff agrees with the walk (one walk for both).
    const whole = ref.contentTypes && ref.folder !== null ? ref.folder : 'application/zip'
    if (list.length > 0) expect(sniffType(bytes, 'x.bin')).toBe(whole)
  },
)

test('a header that is not one stops the walk', () => {
  const walk = new ZipWalk()
  walk.push(new Uint8Array(30))
  expect(walk.stopped).toBe(true)
})
