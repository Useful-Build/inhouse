// What a log line or a stored row may say about a caught error (P8a P-auth): its name and a known code, never its
// message, stack, cause or the caught value itself. Ways it could fail, written down first:
//  1. the message, the stack or a cause's message reaches the output (they can quote chat, customer, tool or file
//     content, or a secret);
//  2. a thrown non-Error (a string, an object) is passed through as text;
//  3. a name or code that isn't an identifier (prose put there) is passed through;
//  4. a storage failure's own message quotes what D1 or R2 said (StoreUnavailableError fed every log above it).
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { StoreUnavailableError } from './db/sql.ts'
import { safeError } from './safe-error.ts'

const CANARY = 'CANARY-chat-text-7f3a'

const errorWith = (name: string, code: unknown, message: string, cause: unknown) => {
  const e = new Error(message, { cause })
  e.name = name
  if (code !== undefined) (e as Error & { code?: unknown }).code = code
  return e
}

describe('safeError', () => {
  test.prop([fc.string(), fc.oneof(fc.constant(undefined), fc.string(), fc.integer()), fc.string(), fc.string(), fc.string()])(
    'depends on the name and code only (failure 1)', (name, code, m1, m2, cause) => {
      const a = errorWith(name, code, m1, cause)
      const b = errorWith(name, code, m2, new Error(m2))
      b.stack = m2
      expect(safeError(a)).toBe(safeError(b))
      expect(safeError(a)).toMatch(/^[A-Za-z0-9_.:-]{1,129}$/)
    })
  it('drops a message, stack and cause holding the canary', () => {
    const e = new TypeError(`bad JSON: ${CANARY}`, { cause: new Error(CANARY) })
    expect(safeError(e)).toBe('TypeError')
    expect(safeError(Object.assign(new Error(CANARY), { code: 'ENOENT' }))).toBe('Error:ENOENT')
    expect(safeError(Object.assign(new Error(CANARY), { code: 503 }))).toBe('Error:503')
  })
  test.prop([fc.anything().filter(v => !(v instanceof Error))])('a thrown non-Error is unknown (failure 2)', v => {
    expect(safeError(v)).toBe('unknown')
  })
  it('a name or code that is prose is not passed through (failure 3)', () => {
    expect(safeError(errorWith(`${CANARY} said hello`, undefined, '', undefined))).toBe('Error')
    expect(safeError(errorWith('Error', `${CANARY} said hello`, '', undefined))).toBe('Error')
  })
})

describe('StoreUnavailableError (failure 4)', () => {
  it("names what failed and keeps the storage error as its cause, not in its message", () => {
    const cause = new Error(`D1_ERROR: UNIQUE constraint failed: ${CANARY}`)
    const e = new StoreUnavailableError('D1', cause)
    expect(e.message).toBe('D1 failed')
    expect(e.message).not.toContain(CANARY)
    expect(e.cause).toBe(cause)
  })
  it('says which store failed, as its code', () => {
    expect(safeError(new StoreUnavailableError('R2', new Error(CANARY)))).toBe('StoreUnavailableError:R2')
    expect(safeError(new StoreUnavailableError('usage ledger', new Error(CANARY)))).toBe('StoreUnavailableError:usage_ledger')
  })
})
