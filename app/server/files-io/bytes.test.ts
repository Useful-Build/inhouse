// A file's body streamed into R2 (p3-design 8.5, "a streamed size"), in the Workers runtime with the real R2 binding.
// Expected hashes are literals (`shasum -a 256` over the same bytes, outside this code). Ways it can fail, written first:
//  1. a large body is held whole in memory before (or while) it's written: peak memory about the file's size;
//  2. a body shorter or longer than declared is kept, or leaves an object in R2 (also when the extra bytes come in a
//     chunk of their own after exactly the declared length);
//  3. the type check sees less than it did: HTML at the start is kept, a long text body with a NUL or broken UTF-8 after
//     the sniffed prefix is kept, or a multi-byte character cut by the prefix's end refuses a good text file;
//  4. the hash or size recorded isn't the body's; a wrong claimed hash leaves an object;
//  5. a failed R2 write is answered as kept.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { SNIFF_PREFIX_BYTES, streamFile } from './bytes.ts'
import type { FilePut } from './bytes.ts'

const MAX = 20_971_520
const MiB = 1_048_576
const CHUNK = 65_536
const SHA_20MIB_A = '48b6fb8f1c2fec38d030604889d674722c4af237733c913b698400b59c9294b4'
const SHA_2MIB_D = '74f67726cae446e21e6c25e6b545cc1d39de1c6fd01bcdb7fe37b1062d6105f0'
let n = 0
const key = () => `files/stream-test/${++n}-${Math.random().toString(36).slice(2, 8)}`

/** A pull-only body of `total` bytes in `chunk`-sized pieces (`byte(i)` at offset i); counts what's been pulled. */
function source(total: number, byte: (i: number) => number, chunk = CHUNK, extra: Uint8Array | null = null) {
  const s = { pulled: 0, stream: null as unknown as ReadableStream<Uint8Array> }
  let at = 0
  let extraSent = false
  s.stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= total) {
        if (extra && !extraSent) {
          extraSent = true
          s.pulled += extra.byteLength
          c.enqueue(extra)
          return
        }
        c.close()
        return
      }
      const len = Math.min(chunk, total - at)
      const b = new Uint8Array(len)
      for (let i = 0; i < len; i++) b[i] = byte(at + i)
      at += len
      s.pulled += len
      c.enqueue(b)
    },
  }, { highWaterMark: 0 })
  return s
}

const request = (body: BodyInit | null, length: number | null) =>
  new Request('https://egress.test/files/x', { method: 'PUT', body, headers: length === null ? {} : { 'content-length': String(length) } })

/** A put that reads the stream piece by piece and records how far the body's pulls ran ahead of what it consumed. */
function countingPut(src: { pulled: number }) {
  const c = { consumed: 0, maxAhead: 0, calls: 0 }
  const put: FilePut = async body => {
    c.calls++
    const r = body.getReader()
    for (;;) {
      const { done, value } = await r.read()
      if (done) break
      c.consumed += value.byteLength
      c.maxAhead = Math.max(c.maxAhead, src.pulled - c.consumed)
    }
  }
  return { c, put }
}
const r2Put = (k: string): FilePut => (body, contentType) => env.FILES.put(k, body, { httpMetadata: { contentType } })

describe('a large body is never held whole (failure 1)', () => {
  it('20 MiB of text: the pulls never run more than the prefix and a few chunks ahead of the put; literal hash and size', async () => {
    const src = source(MAX, () => 0x61)
    const { c, put } = countingPut(src)
    const r = await streamFile(request(src.stream, MAX), 'big.txt', { max: MAX, put })
    expect(r).toEqual({ contentType: 'text/plain', sha256: SHA_20MIB_A, bytes: MAX })
    expect(c.consumed).toBe(MAX)
    // Prefix (1 MiB) plus at most four chunks in flight: far below the 20 MiB a whole-body buffer holds.
    expect(c.maxAhead).toBeLessThanOrEqual(SNIFF_PREFIX_BYTES + 4 * CHUNK)
  })

  it('20 MiB into the real R2: kept whole, the bytes read back hash to the literal', async () => {
    const k = key()
    const src = source(MAX, () => 0x61)
    const r = await streamFile(request(src.stream, MAX), 'big.txt', { max: MAX, put: r2Put(k) })
    expect(r).toEqual({ contentType: 'text/plain', sha256: SHA_20MIB_A, bytes: MAX })
    const back = await env.FILES.get(k)
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await back!.arrayBuffer()))].map(x => x.toString(16).padStart(2, '0')).join('')
    expect(hash).toBe(SHA_20MIB_A)
  })

  it('one byte over the cap is refused before anything is read or written', async () => {
    const src = source(MAX + 1, () => 0x61)
    const { c, put } = countingPut(src)
    expect(await streamFile(request(src.stream, MAX + 1), 'big.txt', { max: MAX, put })).toEqual({ refused: 'too_large' })
    expect([src.pulled, c.calls]).toEqual([0, 0])
  })
})

describe('short and long bodies (failure 2)', () => {
  const cases: [string, number, () => { stream: ReadableStream<Uint8Array> }][] = [
    ['short, under the prefix', 100, () => source(99, () => 0x64)],
    ['long, under the prefix', 100, () => source(101, () => 0x64)],
    ['short, past the prefix', 2 * MiB, () => source(2 * MiB - 1, () => 0x64)],
    ['long, past the prefix', 2 * MiB, () => source(2 * MiB + 1, () => 0x64)],
    ['long by a chunk after exactly the declared length', 2 * MiB, () => source(2 * MiB, () => 0x64, CHUNK, new Uint8Array([0x64]))],
    ['long by a chunk after exactly the prefix-size length', MiB, () => source(MiB, () => 0x64, CHUNK, new Uint8Array([0x64]))],
  ]
  for (const [name, declared, make] of cases) {
    it(`${name}: refused, nothing in R2`, async () => {
      const k = key()
      expect(await streamFile(request(make().stream, declared), 'd.txt', { max: MAX, put: r2Put(k) })).toEqual({ refused: 'length_mismatch' })
      expect(await env.FILES.head(k)).toBeNull()
    })
  }
  it('exactly the declared length past the prefix is kept, literal hash', async () => {
    const k = key()
    const r = await streamFile(request(source(2 * MiB, () => 0x64).stream, 2 * MiB), 'd.txt', { max: MAX, put: r2Put(k) })
    expect(r).toEqual({ contentType: 'text/plain', sha256: SHA_2MIB_D, bytes: 2 * MiB })
    expect((await env.FILES.head(k))?.size).toBe(2 * MiB)
  })
  it('no declared length: refused before reading', async () => {
    const k = key()
    const src = source(10, () => 0x64)
    // A stream body has no length of its own, so the request carries none unless one is set.
    expect(await streamFile(request(src.stream, null), 'd.txt', { max: MAX, put: r2Put(k) })).toEqual({ refused: 'length_required' })
    expect(src.pulled).toBe(0)
  })
})

describe('the type check past the prefix (failure 3)', () => {
  const text2MiB = (at: number, bytes: number[]) => (i: number) => (i >= at && i < at + bytes.length ? bytes[i - at]! : 0x64)
  const refusedCases: [string, (i: number) => number, string][] = [
    ['a NUL after the prefix', text2MiB(2 * MiB - 10, [0x00]), 'd.txt'],
    ['invalid UTF-8 after the prefix', text2MiB(MiB + 5, [0xff]), 'd.csv'],
    ['a UTF-8 sequence cut by the body end', text2MiB(2 * MiB - 1, [0xe2]), 'd.md'],
    ['HTML at the start of a long body', text2MiB(0, [...new TextEncoder().encode('<html><script>x</script>')]), 'd.csv'],
    ['SVG at the start of a long body', text2MiB(0, [...new TextEncoder().encode('<svg onload="x">')]), 'd.png'],
  ]
  for (const [name, byte, file] of refusedCases) {
    it(`${name}: type_not_allowed, nothing in R2`, async () => {
      const k = key()
      expect(await streamFile(request(source(2 * MiB, byte).stream, 2 * MiB), file, { max: MAX, put: r2Put(k) })).toEqual({ refused: 'type_not_allowed' })
      expect(await env.FILES.head(k)).toBeNull()
    })
  }
  it('a type refused from the prefix never starts the put', async () => {
    const src = source(2 * MiB, text2MiB(0, [...new TextEncoder().encode('<!DOCTYPE html>')]))
    const { c, put } = countingPut(src)
    expect(await streamFile(request(src.stream, 2 * MiB), 'p.txt.html', { max: MAX, put })).toEqual({ refused: 'type_not_allowed' })
    expect(c.calls).toBe(0)
  })
  const keptCases: [string, (i: number) => number, string, string][] = [
    // "é" is C3 A9: the prefix's last byte is C3, its pair the first byte after it.
    ['a two-byte character cut by the prefix end', text2MiB(MiB - 1, [0xc3, 0xa9]), 'd.txt', 'text/plain'],
    ['a four-byte character cut by the prefix end', text2MiB(MiB - 2, [0xf0, 0x9f, 0x98, 0x80]), 'd.csv', 'text/csv'],
    ['a long PNG (magic bytes only, the rest binary)', text2MiB(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), 'a.bin', 'image/png'],
    ['a long PDF with a NUL inside', text2MiB(0, [...new TextEncoder().encode('%PDF-1.7\n'), 0x00]), 'a.pdf', 'application/pdf'],
    // JSON is JSON only when the whole body parses: a long one is kept as plain text (its download name gains .txt),
    // even when its prefix alone parses (all digits).
    ['a long JSON body whose prefix parses', () => 0x31, 'n.json', 'text/plain'],
  ]
  for (const [name, byte, file, type] of keptCases) {
    it(`${name}: kept as ${type}`, async () => {
      const k = key()
      const r = await streamFile(request(source(2 * MiB, byte).stream, 2 * MiB), file, { max: MAX, put: r2Put(k) })
      expect(r).toMatchObject({ contentType: type, bytes: 2 * MiB })
      expect((await env.FILES.head(k))?.httpMetadata?.contentType).toBe(type)
    })
  }
})

describe('the last chunk waits for every check (failures 2, 3, 4)', () => {
  // A store that commits once it has the declared bytes, without waiting for the stream's end: a refusal found at the
  // body's end must still come before the last bytes reach it.
  const eagerPut = (length: number) => {
    const c = { got: 0, committed: false }
    const put: FilePut = async body => {
      const r = body.getReader()
      while (c.got < length) {
        const { done, value } = await r.read()
        if (done) break
        c.got += value.byteLength
      }
      if (c.got === length) c.committed = true
    }
    return { c, put }
  }
  const cases: [string, () => { stream: ReadableStream<Uint8Array> }, string | undefined, string][] = [
    ['a UTF-8 sequence cut by the body end', () => source(2 * MiB, i => (i === 2 * MiB - 1 ? 0xe2 : 0x64)), undefined, 'type_not_allowed'],
    ['a wrong claimed hash', () => source(2 * MiB, () => 0x64), 'c'.repeat(64), 'hash'],
    ['an extra chunk after exactly the declared length', () => source(2 * MiB, () => 0x64, CHUNK, new Uint8Array([0x64])), undefined, 'length_mismatch'],
  ]
  for (const [name, make, sha256, refused] of cases) {
    it(`${name}: refused before the store has every byte`, async () => {
      const { c, put } = eagerPut(2 * MiB)
      expect(await streamFile(request(make().stream, 2 * MiB), 'd.txt', { max: MAX, sha256, put })).toEqual({ refused })
      expect(c.committed).toBe(false)
    })
  }
})

describe('the claimed hash and a failed write (failures 4, 5)', () => {
  it('a wrong claimed hash past the prefix: refused, nothing in R2; the right one is kept', async () => {
    const wrong = key()
    const put = (k: string, sha256: string): FilePut => (body, contentType) => env.FILES.put(k, body, { sha256, httpMetadata: { contentType } })
    const bad = 'a'.repeat(64)
    expect(await streamFile(request(source(2 * MiB, () => 0x64).stream, 2 * MiB), 'd.txt', { max: MAX, sha256: bad, put: put(wrong, bad) })).toEqual({ refused: 'hash' })
    expect(await env.FILES.head(wrong)).toBeNull()
    const right = key()
    expect(await streamFile(request(source(2 * MiB, () => 0x64).stream, 2 * MiB), 'd.txt', { max: MAX, sha256: SHA_2MIB_D, put: put(right, SHA_2MIB_D) }))
      .toEqual({ contentType: 'text/plain', sha256: SHA_2MIB_D, bytes: 2 * MiB })
    expect((await env.FILES.head(right))?.size).toBe(2 * MiB)
  })
  it('a put that fails mid-body is answered as failed, with its error', async () => {
    const boom = new Error('r2 down')
    const put: FilePut = async body => {
      const r = body.getReader()
      await r.read()
      await r.cancel()
      throw boom
    }
    const r = await streamFile(request(source(2 * MiB, () => 0x64).stream, 2 * MiB), 'd.txt', { max: MAX, put })
    expect(r).toEqual({ failed: boom })
  })
  it('a put that fails at once, on a small body', async () => {
    const boom = new Error('r2 down')
    expect(await streamFile(request('a,1\n', 4), 'a.csv', { max: MAX, put: async () => { throw boom } })).toEqual({ failed: boom })
  })
  it('an empty body is kept (literal hash of nothing)', async () => {
    const k = key()
    expect(await streamFile(request(null, 0), 'e.txt', { max: MAX, put: r2Put(k) }))
      .toEqual({ contentType: 'text/plain', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', bytes: 0 })
    expect((await env.FILES.head(k))?.size).toBe(0)
  })
})
