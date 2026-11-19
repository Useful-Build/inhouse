// The local channel. Ways it could fail: the run token rides over it; a session can send `started` (the root's own);
// garbage parses; a huge SDK message is passed through whole; a message nested deep enough to overflow the stack
// throws out of the root's listener; how the bytes are chunked changes what the reader yields; a line split mid-UTF-8
// is misread; the cap is off by one; a partial last line is taken for a whole one; a valid run start is too big for
// the session's side of the channel.
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { PROMPT_MAX_CHARS, RUN_START_MAX_BYTES } from '../../../shared/protocol/index.ts'
import { RootMessage, RunConfig, capSdkMessage, parseSessionMessage } from '../../src/protocol/local.ts'
import { LOCAL_MAX_DEPTH, LineReader, ROOT_TO_SESSION_MAX_BYTES, deeperThan, encodeLine, type LineResult } from '../../src/protocol/ndjson.ts'
import { runStart } from '../run/support/root-client.ts'

const nested = (depth: number) => JSON.parse(`${'['.repeat(depth)}${']'.repeat(depth)}`) as unknown

describe('the local channel', () => {
  it('a run message with a runToken is refused', () => {
    const { runToken, ...config } = runStart()
    expect(RootMessage.safeParse({ type: 'run', config }).success).toBe(true)
    expect(RootMessage.safeParse({ type: 'run', config: { ...config, runToken } }).success).toBe(false)
    expect(Object.keys(RunConfig.shape)).not.toContain('runToken')
  })

  it('a session cannot send started', () => {
    const r = parseSessionMessage({ type: 'event', event: { type: 'started', sessionId: runStart().sessionId, resume: false } })
    expect(r.ok).toBe(false)
  })

  it.prop([fc.anything()])('anything that is not a session message is refused without throwing', (raw) => {
    const r = parseSessionMessage(raw)
    if (r.ok) expect(['ready', 'event']).toContain(r.message.type)
  })

  it.prop([fc.dictionary(fc.string(), fc.jsonValue({ depthSize: 'large', maxDepth: 40 })), fc.integer({ min: 10, max: 2000 })])(
    'capSdkMessage keeps a message within the cap whole, and stubs a bigger one',
    (message, cap) => {
      const out = capSdkMessage(message, cap)!
      const bytes = Buffer.byteLength(JSON.stringify(message))
      if (bytes <= cap) expect(out).toEqual({ message, truncated: false })
      else {
        expect(out.truncated).toBe(true)
        expect(out.message.bytes).toBe(bytes)
        expect(Buffer.byteLength(JSON.stringify(out.message))).toBeLessThan(200)
      }
    },
  )

  it('capSdkMessage gives null, never throws, on a message JSON cannot encode (nested past the stack)', () => {
    expect(capSdkMessage({ type: 'assistant', a: nested(300_000) }, 256 * 1024)).toBeNull()
  })

  it("the session's side takes the largest run message a valid RunStart can make", () => {
    // Control characters escape to six bytes each: the longest prompt RunStart allows, in its most expensive form.
    const prompt = '\u0001'.repeat(PROMPT_MAX_CHARS)
    const start = runStart({ prompt })
    expect(Buffer.byteLength(JSON.stringify(start))).toBeLessThanOrEqual(RUN_START_MAX_BYTES)
    const { runToken: _, ...config } = start
    expect(RootMessage.safeParse({ type: 'run', config }).success).toBe(true)
    const line = Buffer.from(encodeLine({ type: 'run', config }))
    expect(line.length).toBeGreaterThan(1024 * 1024)
    expect(new LineReader(ROOT_TO_SESSION_MAX_BYTES).push(line)).toEqual([{ ok: true, value: { type: 'run', config } }])
    // And the cap covers any body the root accepts, with room for the message's own wrapping.
    expect(ROOT_TO_SESSION_MAX_BYTES).toBeGreaterThanOrEqual(RUN_START_MAX_BYTES + 1024)
  })
})

describe('LineReader', () => {
  const feed = (reader: LineReader, chunks: Buffer[]): LineResult[] => [...chunks.flatMap((c) => reader.push(c)), ...reader.end()]
  const splitAt = (buf: Buffer, cuts: number[]) => {
    const points = [...new Set(cuts.map((c) => c % (buf.length + 1)))].sort((a, b) => a - b)
    const out: Buffer[] = []
    let last = 0
    for (const p of points) {
      out.push(buf.subarray(last, p))
      last = p
    }
    out.push(buf.subarray(last))
    return out
  }

  // Multi-byte text, so cuts land inside UTF-8 sequences; bad lines too, so the stop-at-first-error rule is covered.
  const line = fc.oneof(
    fc.jsonValue({ maxDepth: 4 }).map((v) => encodeLine(v)),
    fc.string({ unit: 'grapheme' }).map((t) => encodeLine({ t })),
    fc.constant('not json\n'),
  )
  it.prop([fc.array(line, { maxLength: 8 }), fc.array(fc.nat(), { maxLength: 12 }), fc.integer({ min: 1, max: 400 })])(
    'any chunking of the same bytes yields the same results',
    (lines, cuts, cap) => {
      const bytes = Buffer.from(lines.join(''))
      const whole = feed(new LineReader(cap), [bytes])
      expect(feed(new LineReader(cap), splitAt(bytes, cuts))).toEqual(whole)
      // And byte by byte.
      expect(feed(new LineReader(cap), [...bytes].map((b) => Buffer.from([b])))).toEqual(whole)
    },
  )

  it('a line split inside a UTF-8 sequence reads as the whole character', () => {
    const bytes = Buffer.from(encodeLine({ t: 'é😀' }))
    const mid = bytes.indexOf(Buffer.from('😀')) + 2
    const reader = new LineReader()
    expect(reader.push(bytes.subarray(0, mid))).toEqual([])
    expect(reader.push(bytes.subarray(mid))).toEqual([{ ok: true, value: { t: 'é😀' } }])
  })

  it('a line of exactly the cap is read; one byte more is refused, whole or in pieces', () => {
    const exact = (n: number) => Buffer.from(`"${'a'.repeat(n - 2)}"\n`)
    expect(new LineReader(100).push(exact(100))).toEqual([{ ok: true, value: 'a'.repeat(98) }])
    expect(new LineReader(100).push(exact(101))).toEqual([{ ok: false, error: 'line over the size cap' }])
    const split = new LineReader(100)
    expect(split.push(exact(101).subarray(0, 60))).toEqual([])
    expect(split.push(exact(101).subarray(60))).toEqual([{ ok: false, error: 'line over the size cap' }])
    // Unterminated, past the cap: refused as soon as it's over, without waiting for the newline.
    expect(new LineReader(100).push(Buffer.from('a'.repeat(101)))).toEqual([{ ok: false, error: 'line over the size cap' }])
  })

  it('end() with a partial last line is an error; with nothing left, nothing', () => {
    const r = new LineReader()
    expect(r.push(Buffer.from('{"a":1}\n{"b"'))).toEqual([{ ok: true, value: { a: 1 } }])
    expect(r.end()).toEqual([{ ok: false, error: 'unterminated last line' }])
    const clean = new LineReader()
    clean.push(Buffer.from('1\n'))
    expect(clean.end()).toEqual([])
  })

  it('a line nested past the depth cap is refused; one at the cap is read', () => {
    expect(new LineReader().push(Buffer.from(encodeLine(nested(LOCAL_MAX_DEPTH))))).toEqual([{ ok: true, value: nested(LOCAL_MAX_DEPTH) }])
    expect(new LineReader().push(Buffer.from(`${'['.repeat(300_000)}${']'.repeat(300_000)}\n`))).toEqual([{ ok: false, error: 'line nested too deep' }])
    expect(new LineReader().push(Buffer.from(`{"a":${'{"b":'.repeat(LOCAL_MAX_DEPTH)}1${'}'.repeat(LOCAL_MAX_DEPTH)}}\n`))).toEqual([
      { ok: false, error: 'line nested too deep' },
    ])
  })

  it.prop([fc.jsonValue({ maxDepth: 12 }), fc.integer({ min: 1, max: 12 })])('deeperThan matches a recursive depth count', (value, max) => {
    const depth = (v: unknown): number => (typeof v === 'object' && v !== null ? 1 + Math.max(0, ...Object.values(v).map(depth)) : 0)
    expect(deeperThan(value, max)).toBe(depth(value) > max)
  })
})
