// The R2 key builders (P8 setup). Ways they can fail, written down first:
//  1. a key lands outside its prefix (a lifecycle rule or a registry entry then misses it);
//  2. two different inputs give one key (a backup part, a restore file or a log entry overwrites another);
//  3. the deletion log doesn't list in time order across runs (F1's replay starts after a watermark with `startAfter`),
//     or in write order (step) within one run, whose entries all share one `atMs`.
// `/` and the key's own separators are kept out of the generated ids, as the real ids (hex, `m_…`) never hold them.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { R2_PREFIXES, backupManifestKey, backupPartKey, deletionLogKey, photoKey, restoreKey } from './r2-keys.ts'

const id = fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/)
const part = fc.integer({ min: 0, max: 99_999 })
const atMs = fc.integer({ min: 0, max: 9_999_999_999_999 })
const phase = fc.constantFrom('start', 'done', 'refused')
const step = fc.integer({ min: 0, max: 9999 })

describe('R2 key builders', () => {
  it('lists the new prefixes', () => {
    expect(R2_PREFIXES).toEqual(expect.arrayContaining(['photos/', 'backups/', 'restore/', 'deletion-log/']))
  })

  it('keeps every key under its prefix (failure 1)', () => {
    fc.assert(fc.property(id, id, id, part, atMs, phase, step, (a, b, c, p, t, ph, st) => {
      expect(backupManifestKey(a).startsWith('backups/')).toBe(true)
      expect(backupPartKey(a, b, p).startsWith('backups/')).toBe(true)
      expect(restoreKey(a, 'snapshot/manifest.json').startsWith('restore/')).toBe(true)
      expect(deletionLogKey(t, c, st, ph).startsWith('deletion-log/')).toBe(true)
      expect(photoKey(a, b).startsWith('photos/')).toBe(true)
    }))
  })

  it('has the layouts the G briefs rely on', () => {
    expect(backupManifestKey('B1')).toBe('backups/d1/B1/manifest.json')
    expect(backupPartKey('B1', 'members', 3)).toBe('backups/d1/B1/members/00003.ndjson')
    expect(restoreKey('R1', 'record.json')).toBe('restore/R1/record.json')
    expect(deletionLogKey(42, 'abc', 1, 'done')).toBe('deletion-log/0000000000042-abc-0001-done.json')
  })

  it('gives distinct inputs distinct keys (failure 2)', () => {
    fc.assert(fc.property(fc.tuple(id, id, part), fc.tuple(id, id, part), ([a, t, p], [a2, t2, p2]) => {
      fc.pre(a !== a2 || t !== t2 || p !== p2)
      expect(backupPartKey(a, t, p)).not.toBe(backupPartKey(a2, t2, p2))
      fc.pre(a !== a2)
      expect(backupManifestKey(a)).not.toBe(backupManifestKey(a2))
      expect(restoreKey(a, 'record.json')).not.toBe(restoreKey(a2, 'record.json'))
    }))
    // The deletion log on its own: a precondition above must not skip it.
    fc.assert(fc.property(fc.tuple(atMs, id, step, phase), fc.tuple(atMs, id, step, phase), (x, y) => {
      fc.pre(x.some((v, i) => v !== y[i]))
      expect(deletionLogKey(...x)).not.toBe(deletionLogKey(...y))
    }))
  })

  // The oracle: entries ordered by (atMs, runId, step) as numbers and strings, never through the key text.
  const hexRun = fc.stringMatching(/^[0-9a-f]{16}$/)
  const entry = fc.tuple(atMs, hexRun, step, phase)
  const byOracle = (a: [number, string, number, string], b: [number, string, number, string]) =>
    a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || a[2] - b[2]

  it('lists the deletion log by time across runs and by step within one run (failure 3)', () => {
    fc.assert(fc.property(fc.uniqueArray(entry, { minLength: 2, maxLength: 20, selector: e => `${e[0]} ${e[1]} ${e[2]}` }), entries => {
      const listed = [...entries].sort((a, b) => (deletionLogKey(...a) < deletionLogKey(...b) ? -1 : 1))
      expect(listed).toEqual([...entries].sort(byOracle))
    }))
  })

  it('lists one run\'s entries in write order, whatever their phases (failure 3)', () => {
    fc.assert(fc.property(atMs, hexRun, fc.array(phase, { minLength: 1, maxLength: 12 }), (t, run, phases) => {
      const keys = phases.map((ph, i) => deletionLogKey(t, run, i, ph))
      expect([...keys].sort()).toEqual(keys)
    }))
  })

  it('refuses an id that would escape its prefix', () => {
    expect(() => backupManifestKey('../x')).toThrow()
    expect(() => restoreKey('a/b', 'record.json')).toThrow()
    expect(() => deletionLogKey(1, 'a/b', 0, 'done')).toThrow()
    for (const bad of [-1, 10_000, 1.5, Number.NaN]) expect(() => deletionLogKey(1, 'abc', bad, 'done')).toThrow(/step/)
    for (const bad of [-1, 10_000_000_000_000, 1.5]) expect(() => deletionLogKey(bad, 'abc', 0, 'done')).toThrow(/atMs/)
  })
})
