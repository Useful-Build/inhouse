// A chip saved before a reload must never name a file held after it. Ways it could break, written first:
//  - the keys restart after a reload (a counter), so a restored `pending-1` resolves to the first file attached on the new page
//    (attach contract.pdf, reload, attach salary.xlsx, send: salary goes up twice, once shown as contract.pdf);
//  - a restored chip still carries its key into the next session's drafts.
import { fc, test as fcTest } from '@fast-check/vitest'
import { describe, expect, test, vi } from 'vitest'
import type { Attachment } from '../agent/types'

const file = (name: string) => new File(['x'], name)

describe('pending keys', () => {
  test('a key from before a reload never resolves to a file attached after it', async () => {
    const before = await import('./pending-files')
    const oldKey = before.keepFile(file('contract.pdf'))
    vi.resetModules()
    const after = await import('./pending-files')
    expect(after).not.toBe(before)
    const newKey = after.keepFile(file('salary.xlsx'))
    expect(newKey).not.toBe(oldKey)
    expect(after.heldFile(oldKey)).toBeUndefined()
    expect(after.heldFile(newKey)?.name).toBe('salary.xlsx')
  })

  fcTest.prop([fc.integer({ min: 1, max: 30 })])('keys are all different, and each names its own file', async n => {
    const { keepFile, heldFile } = await import('./pending-files')
    const keys = Array.from({ length: n }, (_, i) => keepFile(file(`f${i}.csv`)))
    expect(new Set(keys).size).toBe(n)
    keys.forEach((k, i) => expect(heldFile(k)?.name).toBe(`f${i}.csv`))
  })

  test('dropFile lets go; withoutPending removes the key and nothing else', async () => {
    const { keepFile, heldFile, dropFile, withoutPending } = await import('./pending-files')
    const k = keepFile(file('a.csv'))
    dropFile(k)
    expect(heldFile(k)).toBeUndefined()
    const atts: Attachment[] = [{ name: 'a.csv', meta: '1 KB', icon: 'description', pending: 'pending-x' }, { name: 'b.csv', meta: '2 KB', icon: 'description', fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA' }]
    expect(withoutPending(atts)).toEqual([{ name: 'a.csv', meta: '1 KB', icon: 'description' }, { name: 'b.csv', meta: '2 KB', icon: 'description', fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA' }])
    expect(atts[0]!.pending).toBe('pending-x')
  })
})
