import { describe, expect, test } from 'vitest'
import { LibraryFileSchema } from './library.ts'
import { RoutineDefSchema } from './routine.ts'

const at = { iso: '2026-01-01T00:00:00.000Z', ms: Date.parse('2026-01-01T00:00:00.000Z') }
const routine = { id: 'r1', name: 'n', what: 'w', freq: 'Daily', day: '', time: { hour: 9, minute: 0 }, next: at, need: 0, rev: 1 }
const file = { id: 'f1', name: 'a.txt', type: 'MD', kind: 'documents', place: 'p', from: 'x', by: 'y', madeByAgent: false, size: '1 KB', at, rev: 1 }

describe('P4 additive flags', () => {
  test.each([[undefined], [true], [false]])('RoutineDef.canManage accepts %s', v => {
    expect(RoutineDefSchema.safeParse({ ...routine, ...(v === undefined ? {} : { canManage: v }) }).success).toBe(true)
  })
  test.each([[undefined], [true], [false]])('LibraryFile.canDelete accepts %s', v => {
    expect(LibraryFileSchema.safeParse({ ...file, ...(v === undefined ? {} : { canDelete: v }) }).success).toBe(true)
  })
  test.each([['yes'], [1], [null]])('both refuse the non-boolean %s', v => {
    expect(RoutineDefSchema.safeParse({ ...routine, canManage: v }).success).toBe(false)
    expect(LibraryFileSchema.safeParse({ ...file, canDelete: v }).success).toBe(false)
  })
})
