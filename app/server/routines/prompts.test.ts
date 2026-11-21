// The system routines' text tables (p4-w2.md sections 4 and 9). Way it can fail: a system routine gets a prompt but no
// description (its Routines page entry would throw), or a description with no prompt.
import { describe, expect, it } from 'vitest'
import { SYSTEM_ROUTINE_DESCRIPTIONS, SYSTEM_ROUTINE_PROMPTS, systemDescription } from './prompts.ts'

describe('the system routine tables', () => {
  it('name the same refs: every prompt has a description and every description a prompt', () => {
    expect(Object.keys(SYSTEM_ROUTINE_DESCRIPTIONS).sort()).toEqual(Object.keys(SYSTEM_ROUTINE_PROMPTS).sort())
  })
  it('an unknown ref fails loud', () => {
    expect(() => systemDescription('no-such-ref')).toThrow('no description')
  })
})
