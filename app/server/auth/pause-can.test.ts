// Pause and Resume (POST /api/pause, POST /api/resume) are gated in the UI by the `editBrandSettings` can key (the Settings
// Pause row, the top bar's Pause button). A `can` key reads one access-matrix row, so the two must have the same class and
// allow list, or a Member sees a button the server refuses (or an Admin loses one it allows). Ways it can fail:
//  1. the matrix changes pause or resume (or the brand settings row) and the key no longer matches.
import { describe, expect, it } from 'vitest'
import { accessMatrix, canRows } from '../access-matrix.ts'

const row = (method: string, pattern: string) => {
  const r = accessMatrix.find(x => x.method === method && x.pattern === pattern)
  if (!r) throw new Error(`no access-matrix row for ${method} ${pattern}`)
  return r
}

describe('the pause gate (editBrandSettings)', () => {
  const key = canRows.editBrandSettings
  const keyRow = row(key.method, key.pattern)
  it.each([['POST', '/api/pause'], ['POST', '/api/resume']])('%s %s has the class and allow list of the editBrandSettings row', (method, pattern) => {
    const r = row(method, pattern)
    expect(r.class).toBe(keyRow.class)
    expect([...r.allow].sort()).toEqual([...keyRow.allow].sort())
  })
})
