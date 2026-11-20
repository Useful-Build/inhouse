// The R2 key builders (P8 setup). Ways they can fail, written down first:
//  1. a key lands outside its prefix (a lifecycle rule or a registry entry then misses it);
//  2. two different inputs give one key (a backup part, a restore file or a log entry overwrites another);
//  3. the deletion log doesn't list in time order (F1's replay starts after a watermark with `startAfter`).
// `/` and the key's own separators are kept out of the generated ids, as the real ids (hex, `m_…`) never hold them.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { R2_PREFIXES, backupManifestKey, backupPartKey, deletionLogKey, photoKey, restoreKey } from './r2-keys.ts'

const id = fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/)
const part = fc.integer({ min: 0, max: 99_999 })
const atMs = fc.integer({ min: 0, max: 9_999_999_999_999 })
const phase = fc.constantFrom('start', 'done', 'refused')

describe('R2 key builders', () => {
  it('lists the new prefixes', () => {
    expect(R2_PREFIXES).toEqual(expect.arrayContaining(['photos/', 'backups/', 'restore/', 'deletion-log/']))
  })

  it('keeps every key under its prefix (failure 1)', () => {
    fc.assert(fc.property(id, id, id, part, atMs, phase, (a, b, c, p, t, ph) => {
      expect(backupManifestKey(a).startsWith('backups/')).toBe(true)
      expect(backupPartKey(a, b, p).startsWith('backups/')).toBe(true)
      expect(restoreKey(a, 'snapshot/manifest.json').startsWith('restore/')).toBe(true)
      expect(deletionLogKey(t, c, ph).startsWith('deletion-log/')).toBe(true)
      expect(photoKey(a, b).startsWith('photos/')).toBe(true)
    }))
  })

  it('has the layouts the G briefs rely on', () => {
    expect(backupManifestKey('B1')).toBe('backups/d1/B1/manifest.json')
    expect(backupPartKey('B1', 'members', 3)).toBe('backups/d1/B1/members/00003.ndjson')
    expect(restoreKey('R1', 'record.json')).toBe('restore/R1/record.json')
    expect(deletionLogKey(42, 'abc', 'done')).toBe('deletion-log/0000000000042-abc-done.json')
  })

  it('gives distinct inputs distinct keys (failure 2)', () => {
    fc.assert(fc.property(fc.tuple(id, id, part, atMs, phase), fc.tuple(id, id, part, atMs, phase), ([a, t, p, ms, ph], [a2, t2, p2, ms2, ph2]) => {
      fc.pre(a !== a2 || t !== t2 || p !== p2)
      expect(backupPartKey(a, t, p)).not.toBe(backupPartKey(a2, t2, p2))
      fc.pre(a !== a2)
      expect(backupManifestKey(a)).not.toBe(backupManifestKey(a2))
      expect(restoreKey(a, 'record.json')).not.toBe(restoreKey(a2, 'record.json'))
      fc.pre(ms !== ms2 || t !== t2 || ph !== ph2)
      expect(deletionLogKey(ms, t, ph)).not.toBe(deletionLogKey(ms2, t2, ph2))
    }))
  })

  it('sorts the deletion log by time (failure 3)', () => {
    fc.assert(fc.property(atMs, atMs, fc.stringMatching(/^[0-9a-f]{16}$/), phase, (x, y, run, ph) => {
      fc.pre(x < y)
      expect(deletionLogKey(x, run, ph) < deletionLogKey(y, run, ph)).toBe(true)
    }))
  })

  it('refuses an id that would escape its prefix', () => {
    expect(() => backupManifestKey('../x')).toThrow()
    expect(() => restoreKey('a/b', 'record.json')).toThrow()
    expect(() => deletionLogKey(1, 'a/b', 'done')).toThrow()
  })
})
