// The synchronous SHA-256 behind `payloadHash` (sha256.ts). Ways it can fail: a padding or length bug at a block edge
// (55, 56, 63, 64 bytes and their neighbours), a wrong constant, or a multi-block message. Checked against the
// standard's vectors and differentially against WebCrypto's digest on random bytes of every length up to 300.
import { fc } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './sha256.ts'

const subtle = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x => x.toString(16).padStart(2, '0')).join('')
const utf8 = (s: string) => new TextEncoder().encode(s)

describe('sha256Hex', () => {
  it('gives the standard\'s test vectors (FIPS 180-4 examples)', () => {
    expect(sha256Hex(utf8(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex(utf8('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })

  it('equals WebCrypto\'s digest on random bytes, every length at a block edge included', async () => {
    for (let n = 0; n <= 300; n++) {
      const b = crypto.getRandomValues(new Uint8Array(n))
      expect(sha256Hex(b), `length ${n}`).toBe(await subtle(b))
    }
    await fc.assert(fc.asyncProperty(fc.uint8Array({ maxLength: 5000 }), async b => { expect(sha256Hex(b)).toBe(await subtle(b)) }))
  })
})
