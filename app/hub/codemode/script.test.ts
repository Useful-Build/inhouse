// The Dynamic Worker's code and the return check (P5 W2, A.3, A.7.7 and A.7.9). Failure modes:
// - the id depends on anything but the code (a run id, a time, randomness): billed twice, or the cache serves other code;
// - two codes share an id;
// - the WorkerCode gets network or anything in env;
// - the hub parses more than 8 KiB, or trusts a non-string;
// - an error's text is unbounded or read through a throwing getter.
import { createHash } from 'node:crypto'
import fc from 'fast-check'
import { test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { BAD_RETURN, errorText, readReturn, scriptId, userModule, workerCode, WRAPPER, WRAPPER_VERSION } from './script'
import { COMPATIBILITY_DATE, MAX_ERROR_CHARS, MAX_RETURN_BYTES } from './caps'

/** The reference: SHA-256 over `<version>\n<code>`, by node:crypto. */
const reference = (code: string) => `cm1-${createHash('sha256').update(`${WRAPPER_VERSION}\n${code}`, 'utf8').digest('hex')}`

describe('scriptId', () => {
  test.prop([fc.string({ unit: 'binary' })])('is the SHA-256 of the version and the code, and stable', async code => {
    expect(await scriptId(code)).toBe(reference(code))
    expect(await scriptId(code)).toBe(await scriptId(code))
  })

  test.prop([fc.string(), fc.nat(), fc.string({ minLength: 1, maxLength: 1 })])('codes one character apart get two ids', async (code, at, ch) => {
    const i = Math.min(at, code.length)
    const other = code.slice(0, i) + ch + code.slice(i)
    expect(await scriptId(other)).not.toBe(await scriptId(code))
  })
})

/**
 * The wrapper and runtime each version pins (review L5). A cached isolate is keyed by the id, which hashes only the
 * code and WRAPPER_VERSION: change WRAPPER or COMPATIBILITY_DATE without a bump and old ids would serve old wrappers.
 * Add a line here with the new version's hash when you bump it.
 */
const PINNED: Record<number, string> = {
  3: 'ea3abb2157b890671ec317d254fc09ff4b24117a1bf8bb42ac0fdd4ead43cdfd',
}

describe('WRAPPER_VERSION', () => {
  it('pins the wrapper text and compatibility date', () => {
    const hash = createHash('sha256').update(`${COMPATIBILITY_DATE}\n${WRAPPER}`, 'utf8').digest('hex')
    if (PINNED[WRAPPER_VERSION] !== hash) {
      throw new Error(`WRAPPER or COMPATIBILITY_DATE changed: bump WRAPPER_VERSION and pin its hash (${hash}) in script.test.ts`)
    }
    expect(Object.entries(PINNED).filter(([v, h]) => Number(v) !== WRAPPER_VERSION && h === hash)).toEqual([])
  })
})

describe('workerCode', () => {
  it('has no network, nothing in env, the fixed wrapper and the code as a module', () => {
    const code = 'return 1'
    const w = workerCode(code)
    expect(w).toEqual({
      compatibilityDate: '2026-11-11',
      mainModule: 'script.js',
      modules: { 'script.js': WRAPPER, 'user.js': userModule(code) },
      globalOutbound: null,
      env: {},
    })
    expect(Object.keys(w).sort()).toEqual(['compatibilityDate', 'env', 'globalOutbound', 'mainModule', 'modules'])
    expect(userModule(code)).toBe('export default async (shop) => {\nreturn 1\n}\n')
    expect(workerCode(code)).toEqual(workerCode(code))
  })
})

describe('readReturn', () => {
  it('parses a small JSON string and refuses everything else', () => {
    expect(readReturn('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(readReturn('null')).toEqual({ ok: true, value: null })
    for (const v of [{ a: 1 }, 1, null, undefined, () => 1, ['x'], 'not json', '{"a":']) expect(readReturn(v), String(v)).toEqual({ ok: false })
  })

  it('8 KiB passes, 8 KiB + 1 byte fails, counted in UTF-8', () => {
    const at = (n: number) => JSON.stringify('x'.repeat(n - 2))
    expect(readReturn(at(MAX_RETURN_BYTES)).ok).toBe(true)
    expect(readReturn(at(MAX_RETURN_BYTES + 1)).ok).toBe(false)
    // 3 bytes per character in UTF-8, 1 in UTF-16: under the cap by length, over it by bytes.
    const wide = JSON.stringify('€'.repeat(Math.ceil(MAX_RETURN_BYTES / 3)))
    expect(wide.length).toBeLessThan(MAX_RETURN_BYTES)
    expect(readReturn(wide).ok).toBe(false)
    expect(readReturn('9'.repeat(MAX_RETURN_BYTES * 4)).ok).toBe(false)
    expect(BAD_RETURN).toBe('script must return a small JSON value')
  })
})

describe('errorText', () => {
  it('is name and message, at most 500 characters, and never trusts a getter', () => {
    expect(errorText(new TypeError('x is not a function'))).toBe('TypeError: x is not a function')
    expect(errorText(new Error('y'.repeat(2000))).length).toBe(MAX_ERROR_CHARS)
    expect(errorText('a string')).toBe('Error: script failed')
    const hostile = {
      get name(): string {
        throw new Error('boom')
      },
    }
    expect(errorText(hostile)).toBe('Error: script failed')
    expect(errorText({ name: 1, message: { toString: () => 'x' } })).toBe('Error: script failed')
  })
})
