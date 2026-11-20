// The backup's format and the restore's one-statement insert. Ways they can fail, written down first:
//  1. a value changes on the way through NDJSON and json_each: quotes, newlines, backslashes, unicode, a string that
//     looks like a number or JSON, a large or negative integer, a null;
//  2. the sha256 of what was written differs from the sha256 of what the target reads back;
//  3. a part passes 1,000 rows or 1,000,000 bytes (D1 binds at most a 2,000,000-byte string), or a row is lost or
//     doubled at a part boundary;
//  4. a value the format can't hold (a BLOB, an unsafe integer, NaN) is written silently instead of failing by name.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { BackupError } from './errors.ts'
import { PART_BYTES, PART_ROWS, TableWriter, encodeRow, insertPartSql, linesAsArray, partLines, sha256 } from './format.ts'
import { TABLE_RULES } from './tables.ts'
import { intArb, textArb } from './test-support.ts'

const db = env.DB
let scratchN = 0
const infos = new Map<string, { name: string; type: string }[]>()
for (const r of TABLE_RULES) infos.set(r.name, (await db.prepare(`PRAGMA table_info("${r.name}")`).all<{ name: string; type: string }>()).results)

describe('writing a part and inserting it (failures 1, 2)', () => {
  for (const rule of TABLE_RULES) {
    const info = infos.get(rule.name) as { name: string; type: string }[]
    const columns = info.map(c => c.name)
    const cellArb = (type: string): fc.Arbitrary<string | number | null> => fc.option<string | number>(type.toUpperCase().includes('INT') ? intArb : textArb, { nil: null })
    const rowsArb = fc.array(fc.tuple(...info.map(c => cellArb(c.type))), { maxLength: 40 })
      .map(rs => rs.map(cells => Object.fromEntries(columns.map((c, i) => [c, cells[i]]))))
    test.prop([rowsArb], { numRuns: 25 })(`${rule.name}: any rows of its column types read back identical, same sha256`, async rows => {
      const scratch = `scratch_${++scratchN}`
      // A trigger-free copy of the table's columns and types (no constraints, so any generated row fits).
      await db.prepare(`CREATE TABLE ${scratch} AS SELECT * FROM "${rule.name}" WHERE 0`).run()

      const parts: Uint8Array[] = []
      const writer = new TableWriter(scratch, async (_n, bytes) => { parts.push(bytes); return `k${parts.length}` })
      for (const row of rows) await writer.add(encodeRow(scratch, columns, row))
      const written = await writer.finish()
      for (const bytes of parts) await db.prepare(insertPartSql(scratch, columns)).bind(linesAsArray(partLines(new TextDecoder().decode(bytes)))).run()

      const back = (await db.prepare(`SELECT ${columns.map(c => `"${c}"`).join(', ')} FROM ${scratch} ORDER BY rowid`).all<Record<string, unknown>>()).results
      expect(back).toEqual(rows)
      const reread = new TableWriter(scratch, async () => '')
      for (const row of back) await reread.add(encodeRow(scratch, columns, row))
      expect(await reread.finish()).toEqual({ ...written, parts: written.parts.map(p => ({ ...p, key: '' })) })
    })
  }
})

describe('parts (failure 3)', () => {
  const lineArb = fc.oneof({ weight: 20, arbitrary: fc.string({ maxLength: 30 }) }, { weight: 1, arbitrary: fc.string({ minLength: 200_000, maxLength: 400_000 }) })
  test.prop([fc.array(lineArb, { maxLength: 2_600 })], { numRuns: 20 })('close at 1,000 rows or 1,000,000 bytes, and lose or double no row', async values => {
    const lines = values.map(v => `${JSON.stringify([v])}\n`)
    const parts: Uint8Array[] = []
    const writer = new TableWriter('t', async (_n, bytes) => { parts.push(bytes); return `k${parts.length}` })
    for (const l of lines) await writer.add(l)
    const d = await writer.finish()
    const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
    parts.reduce((off, p) => { all.set(p, off); return off + p.byteLength }, 0)
    expect(d.rows).toBe(lines.length)
    expect(d.sha256).toBe(await sha256(all))
    expect(parts.flatMap(p => partLines(new TextDecoder().decode(p)))).toEqual(lines)
    for (const [i, p] of parts.entries()) {
      expect(d.parts[i].rows).toBeLessThanOrEqual(PART_ROWS)
      expect(p.byteLength).toBeLessThanOrEqual(PART_BYTES)
      expect(d.parts[i].sha256).toBe(await sha256(p as Uint8Array<ArrayBuffer>))
    }
  })
  it('refuses a single row over the part size, by name', async () => {
    const writer = new TableWriter('t', async () => '')
    await expect(writer.add(`${JSON.stringify(['x'.repeat(PART_BYTES)])}\n`)).rejects.toThrow(BackupError)
  })
})

describe('a part near the size cap (failure 3)', () => {
  it('writes a ~1,000,000-byte part of multi-byte text as one bound string and reads it back identical', async () => {
    // Note: the local D1 (miniflare) may not enforce D1's 2,000,000-byte string cap, so this proves the round trip at
    // the size, not the cap itself; PART_BYTES leaves half of it free.
    const unit = '\u{1F600}\u00e9\n"\\x'
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: i, body: `${i}:${unit.repeat(18_500)}` }))
    await db.prepare('CREATE TABLE scratch_big (id INTEGER, body TEXT)').run()
    const parts: Uint8Array[] = []
    const writer = new TableWriter('scratch_big', async (_n, bytes) => { parts.push(bytes); return `k${parts.length}` })
    for (const row of rows) await writer.add(encodeRow('scratch_big', ['id', 'body'], row))
    const written = await writer.finish()
    expect(parts).toHaveLength(1)
    expect(parts[0].byteLength).toBeGreaterThan(950_000)
    expect(parts[0].byteLength).toBeLessThanOrEqual(PART_BYTES)
    await db.prepare(insertPartSql('scratch_big', ['id', 'body'])).bind(linesAsArray(partLines(new TextDecoder().decode(parts[0])))).run()
    const back = (await db.prepare('SELECT id, body FROM scratch_big ORDER BY rowid').all<Record<string, unknown>>()).results
    expect(back).toEqual(rows)
    const reread = new TableWriter('scratch_big', async () => '')
    for (const row of back) await reread.add(encodeRow('scratch_big', ['id', 'body'], row))
    expect((await reread.finish()).sha256).toBe(written.sha256)
  })
})

describe('values the format refuses (failure 4)', () => {
  it.each([
    ['a BLOB', [1, 2, 3]],
    ['a buffer', new Uint8Array([1])],
    ['an unsafe integer', 2 ** 60],
    ['NaN', Number.NaN],
    ['undefined (a missing column)', undefined],
  ])('throws by name on %s', (_what, v) => {
    expect(() => encodeRow('members', ['photo_key'], { photo_key: v })).toThrow(/unsupported_value \(members\.photo_key\)/)
  })
})
