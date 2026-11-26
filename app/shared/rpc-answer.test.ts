// shared/rpc-answer.ts: a Workers RPC answer kept as plain data and released. Ways it can fail, written down first:
//  1. the copy still carries the disposer (so a caller passing it on passes the open call on with it);
//  2. the answer's disposer never runs, or runs twice;
//  3. the copy loses or changes plain data (nested objects, arrays, null, undefined fields);
//  4. an answer that can't be copied is returned half-copied or quietly dropped, or isn't released first;
//  5. a primitive answer is touched;
//  6. a function or callable stub at the top passes through uncopied and unreleased (a nested one throws).
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { plainAnswer, releaseAnswer, settledAnswer } from './rpc-answer.ts'

const DISPOSE = (Symbol as unknown as { dispose: symbol }).dispose

/** An answer as Workers RPC hands it over: the data plus a disposer, counted. */
function handed<T extends object>(data: T): { answer: T; released: () => number } {
  let n = 0
  const answer = Object.assign({}, data, { [DISPOSE]: () => { n++ } }) as T
  return { answer, released: () => n }
}

/** The disposer as the runtime adds it: non-enumerable, on any object (an array, a typed array, a Date, an Error). */
function withDisposer<T extends object>(value: T): { answer: T; released: () => number } {
  let n = 0
  Object.defineProperty(value, DISPOSE, { value: () => { n++ }, enumerable: false })
  return { answer: value, released: () => n }
}

describe('plainAnswer', () => {
  it('copies the data without the disposer and releases the answer once', () => {
    const { answer, released } = handed({ ok: true, value: { rows: [{ id: 'a', at: null }], next: undefined } })
    const copy = plainAnswer(answer)
    expect(Object.getOwnPropertySymbols(copy)).toEqual([])
    expect(copy).toEqual({ ok: true, value: { rows: [{ id: 'a', at: null }], next: undefined } })
    expect(copy).not.toBe(answer)
    expect(released()).toBe(1)
  })

  test.prop([fc.dictionary(fc.string().filter(k => k !== '__proto__'), fc.jsonValue())])('any JSON answer comes back equal, symbol-free, released once', data => {
    const { answer, released } = handed(data)
    const copy = plainAnswer(answer)
    expect(Object.getOwnPropertySymbols(copy)).toEqual([])
    expect(copy).toEqual(data)
    expect(released()).toBe(1)
  })

  it('an answer it cannot copy throws, after it is released', () => {
    const { answer, released } = handed({ ok: true, value: { stub: () => 1 } })
    expect(() => plainAnswer(answer)).toThrow()
    expect(released()).toBe(1)
  })

  it('a function or callable stub at the top throws, after it is released', () => {
    const { answer, released } = withDisposer(Object.assign(() => 1, { kind: 'stub' }))
    expect(() => plainAnswer(answer)).toThrow(TypeError)
    expect(released()).toBe(1)
  })

  it('a top-level array, a Uint8Array, a Date and an Error copy as they are, released once', () => {
    const cases: [object, (copy: unknown) => void][] = [
      [[{ id: 'a' }, 2, null], copy => expect(copy).toEqual([{ id: 'a' }, 2, null])],
      [new Uint8Array([1, 2, 255]), copy => { expect(copy).toBeInstanceOf(Uint8Array); expect([...(copy as Uint8Array)]).toEqual([1, 2, 255]) }],
      [new Date(1_700_000_000_000), copy => { expect(copy).toBeInstanceOf(Date); expect((copy as Date).getTime()).toBe(1_700_000_000_000) }],
      [new RangeError('out of range'), copy => { expect(copy).toBeInstanceOf(RangeError); expect((copy as Error).message).toBe('out of range') }],
    ]
    for (const [value, check] of cases) {
      const { answer, released } = withDisposer(value)
      const copy = plainAnswer(answer)
      expect(copy).not.toBe(answer)
      expect(Object.getOwnPropertySymbols(copy)).toEqual([])
      check(copy)
      expect(released()).toBe(1)
    }
  })

  it('primitives and null pass through as they are', () => {
    for (const v of [null, undefined, 0, 'x', true]) expect(plainAnswer(v)).toBe(v)
  })
})

describe('releaseAnswer and settledAnswer', () => {
  it('releaseAnswer runs a disposer when there is one, and ignores anything else', () => {
    const { answer, released } = handed({ ok: true })
    releaseAnswer(answer)
    expect(released()).toBe(1)
    for (const v of [null, undefined, 1, 'x', {}, [], () => 1]) expect(() => releaseAnswer(v)).not.toThrow()
    const stub = withDisposer(() => 1)
    releaseAnswer(stub.answer)
    expect(stub.released()).toBe(1)
  })

  it('settledAnswer awaits the call, then copies and releases', async () => {
    const { answer, released } = handed({ ok: false, error: { code: 'paused', message: 'paused' } })
    const copy = await settledAnswer(Promise.resolve(answer))
    expect(copy).toEqual({ ok: false, error: { code: 'paused', message: 'paused' } })
    expect(Object.getOwnPropertySymbols(copy)).toEqual([])
    expect(released()).toBe(1)
  })
})
