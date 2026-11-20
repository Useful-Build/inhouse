// The body cap (p2-design section 4: 400 `invalid`). Ways it can fail, written down first:
//  1. a body past the cap is read whole (no Content-Length, chunked) before it's refused: the cap must stop the read;
//  2. the cap counts characters, so a multibyte body over the byte limit passes;
//  3. a body at the cap, or a small one, is refused.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MAX_BODY_BYTES, readBody } from './handler-kit.ts'

const schema = z.object({ v: z.string() })
const chunked = (text: string, chunk = 1000) => {
  const bytes = new TextEncoder().encode(text)
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes.length) return controller.close()
      controller.enqueue(bytes.subarray(sent, sent + chunk))
      sent += chunk
    },
  })
  const request = new Request('http://brand.localhost:8787/api/x', { method: 'PUT', body: stream, duplex: 'half' } as RequestInit)
  return Object.assign(request, { pulled: () => sent })
}
const body = (v: string) => JSON.stringify({ v })
const pad = (bytes: number) => 'x'.repeat(bytes - body('').length)

describe('the body cap', () => {
  it('refuses a chunked body over the cap, with no Content-Length (failure 1)', async () => {
    const req = chunked(body(pad(1024 * 1024)))
    expect(req.headers.get('Content-Length')).toBeNull()
    expect('error' in (await readBody(req, schema))).toBe(true)
    // Stopped at the cap: at most a couple of chunks past it were pulled, never the whole megabyte.
    expect(req.pulled()).toBeLessThanOrEqual(MAX_BODY_BYTES + 2000)
    expect('error' in (await readBody(chunked(body(pad(MAX_BODY_BYTES + 1))), schema))).toBe(true)
  })
  it('measures bytes, not characters (failure 2)', async () => {
    // 6000 euro signs: 6000 characters, 18000 bytes.
    const text = body('€'.repeat(6000))
    expect(text.length).toBeLessThan(MAX_BODY_BYTES)
    expect('error' in (await readBody(new Request('http://brand.localhost:8787/api/x', { method: 'PUT', body: text }), schema))).toBe(true)
    expect('error' in (await readBody(chunked(text), schema))).toBe(true)
  })
  it('takes a body exactly at the cap, chunked or not (failure 3)', async () => {
    const text = body(pad(MAX_BODY_BYTES))
    expect(new TextEncoder().encode(text).length).toBe(MAX_BODY_BYTES)
    expect(await readBody(chunked(text), schema)).toEqual({ ok: { v: pad(MAX_BODY_BYTES) } })
    expect(await readBody(new Request('http://brand.localhost:8787/api/x', { method: 'PUT', body: text }), schema)).toEqual({ ok: { v: pad(MAX_BODY_BYTES) } })
  })
})
