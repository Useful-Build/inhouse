// What the root's container logs may say about a caught error (P8a P-auth): its name and its errno code, never its
// message, stack or the caught value. Ways it could fail, written down first:
//  1. the message or stack reaches the output (a Node fs error names the path, and a session's file names are chat
//     content; a parse error quotes the text);
//  2. a thrown non-Error (a string, an object) is passed through as text;
//  3. a name or code that isn't an identifier (prose put there) is passed through.
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { safeError } from '../src/safe-error.ts'

const CANARY = 'CANARY-chat-text-7f3a'

const errorWith = (name: string, code: unknown, message: string) => {
  const e = new Error(message)
  e.name = name
  if (code !== undefined) (e as unknown as { code?: unknown }).code = code
  return e
}

describe('safeError', () => {
  it.prop([fc.string(), fc.oneof(fc.constant(undefined), fc.string(), fc.integer()), fc.string(), fc.string()])(
    'depends on the name and code only (failure 1)', (name, code, m1, m2) => {
      const a = errorWith(name, code, m1)
      const b = errorWith(name, code, m2)
      b.stack = m2
      expect(safeError(a)).toBe(safeError(b))
      expect(safeError(a)).toMatch(/^[A-Za-z0-9_.:-]{1,129}$/)
    })
  it('keeps an errno code and drops the path in the message', () => {
    const e = Object.assign(new Error(`ENOENT: no such file or directory, open '/work/c1/outputs/${CANARY}.csv'`), { code: 'ENOENT', syscall: 'open' })
    expect(safeError(e)).toBe('Error:ENOENT')
    expect(safeError(new SyntaxError(`Unexpected token in JSON: ${CANARY}`))).toBe('SyntaxError')
  })
  it.prop([fc.anything().filter((v) => !(v instanceof Error))])('a thrown non-Error is unknown (failure 2)', (v) => {
    expect(safeError(v)).toBe('unknown')
  })
  it('a name or code that is prose is not passed through (failure 3)', () => {
    expect(safeError(errorWith(`${CANARY} said hello`, undefined, ''))).toBe('Error')
    expect(safeError(errorWith('Error', `${CANARY} said hello`, ''))).toBe('Error')
  })
})
