// The releases file, parsed strictly (P8a K, A10's decision): anything the file shouldn't say is an error, never a
// best-effort list. Ways it can fail, written down first:
//  1. an unknown key, unknown phase, bad SHA or date, or a duplicate `at` is accepted;
//  2. a missing `behaviour` key counts as false;
//  3. the file isn't a JSON array, or is empty JSON text, and is read as "no releases";
//  4. the markers aren't sorted, or a date without a UTC Z is taken as local time.
import { describe, expect, it } from 'vitest'
import { ReleasesError, parseReleases } from './releases.ts'

const sha = 'a'.repeat(40)
const one = (o: object = {}) => JSON.stringify([{ at: '2026-12-01T06:00:00Z', app_sha: sha, live: ['P4', 'P5'], behaviour: false, ...o }])

describe('parseReleases', () => {
  it('reads a marker', () => {
    expect(parseReleases(one())).toEqual([{ atMs: Date.UTC(2026, 11, 1, 6), appSha: sha, live: ['P4', 'P5'], behaviour: false }])
  })
  it('sorts by time', () => {
    const text = JSON.stringify([{ at: '2026-12-02T00:00:00Z', app_sha: 'b'.repeat(40), live: [] }, { at: '2026-12-01T00:00:00Z', app_sha: sha, live: [] }])
    expect(parseReleases(text).map(m => m.appSha)).toEqual([sha, 'b'.repeat(40)])
  })
  it('a missing behaviour key counts as true', () => {
    expect(parseReleases(JSON.stringify([{ at: '2026-12-01T00:00:00Z', app_sha: sha, live: ['P4'] }]))[0]!.behaviour).toBe(true)
  })
  it('accepts fractional seconds and an empty list of releases', () => {
    expect(parseReleases(one({ at: '2026-12-01T06:00:00.250Z' }))[0]!.atMs).toBe(Date.UTC(2026, 11, 1, 6) + 250)
    expect(parseReleases('[]')).toEqual([])
  })
  const bad: [string, string][] = [
    ['not JSON', 'nope'],
    ['empty text', ''],
    ['an object, not an array', '{}'],
    ['a non-object entry', '[1]'],
    ['an unknown key', one({ extra: 1 })],
    ['a missing at', one({ at: undefined })],
    ['a missing app_sha', one({ app_sha: undefined })],
    ['a missing live', one({ live: undefined })],
    ['an unknown phase', one({ live: ['P4', 'P99'] })],
    ['a repeated phase', one({ live: ['P4', 'P4'] })],
    ['live that is not a list', one({ live: 'P4' })],
    ['a short SHA', one({ app_sha: 'abc123' })],
    ['an uppercase SHA', one({ app_sha: 'A'.repeat(40) })],
    ['a date without Z', one({ at: '2026-12-01T06:00:00' })],
    ['a date with an offset', one({ at: '2026-12-01T06:00:00+01:00' })],
    ['a date that does not exist', one({ at: '2026-02-30T00:00:00Z' })],
    ['a date only', one({ at: '2026-12-01' })],
    ['behaviour that is not a boolean', one({ behaviour: 'yes' })],
    ['a duplicate at', JSON.stringify([{ at: '2026-12-01T00:00:00Z', app_sha: sha, live: [] }, { at: '2026-12-01T00:00:00.000Z', app_sha: 'b'.repeat(40), live: [] }])],
  ]
  it.each(bad)('refuses %s', (_name, text) => {
    expect(() => parseReleases(text)).toThrow(ReleasesError)
  })
})
