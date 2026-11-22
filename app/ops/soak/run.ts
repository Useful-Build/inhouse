// The Watch soak's daily driver (P8a K). Collects each UTC day after the last recorded one, up to yesterday, judges it,
// and appends the record to the soak record file: the day's verdict and the running count of consecutive clean days.
// A recorded day is never rewritten.
//
//   node ops/soak/run.ts --db <house D1 name or binding> --record <soak-record.json> [--from YYYY-MM-DD] [--until YYYY-MM-DD]
//                        [--local --persist-to <dir>] [--config <wrangler config with the D1 binding>]
//
// Needs `wrangler` signed in to the account that holds the house D1 (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
// Meant to run once a day from the private ops repo (the nightly's soak step is a workflow, a sensitive path that waits
// for Wasim's OK, so nothing here schedules it). Exit 0: the days were recorded, whatever their verdict. 1: failed. 2: usage.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { collectDay } from './collect.ts'
import type { SoakDb } from './collect.ts'
import { runChecks } from './checks.ts'
import { readMarkers } from './releases.ts'
import type { DayRecord, ReleaseMarker } from './types.ts'
import { dayStartMs, nextDay, nextRecord } from './window.ts'

const MAX_CATCH_UP = 14
const DAY_MS = 86_400_000

export interface SoakRecordFile { records: DayRecord[] }

/** Inlines `?` parameters into a SELECT. Only ours go through: numbers and constant strings. */
export function inline(sql: string, params: readonly (string | number)[]): string {
  let i = 0
  const out = sql.replace(/\?/g, () => {
    const p = params[i++]
    if (p === undefined) throw new Error('soak: a ? has no parameter')
    if (typeof p === 'number') {
      if (!Number.isFinite(p)) throw new Error('soak: a parameter is not finite')
      return String(p)
    }
    return `'${p.replaceAll("'", "''")}'`
  })
  if (i !== params.length) throw new Error('soak: more parameters than ?')
  return out
}

export const isReadOnly = (sql: string): boolean => /^\s*select\b/i.test(sql) && !sql.includes(';')

export function wranglerDb(db: string, local: { persistTo: string } | null, config?: string): SoakDb {
  return async (sql, params = []) => {
    const text = inline(sql, params)
    if (!isReadOnly(text)) throw new Error('soak: only a single SELECT may run')
    const where = local ? ['--local', '--persist-to', local.persistTo] : ['--remote']
    const r = spawnSync('npx', ['wrangler', 'd1', 'execute', db, ...(config ? ['--config', config] : []), ...where, '--json', '--command', text], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0) throw new Error(`wrangler d1 execute failed (${r.status}): ${(r.stderr || r.stdout).slice(0, 400)}`)
    const parsed = JSON.parse(r.stdout) as { results?: Record<string, unknown>[]; success?: boolean }[]
    const first = parsed[0]
    if (!first || first.success === false || !Array.isArray(first.results)) throw new Error('wrangler d1 execute returned no result set')
    return first.results
  }
}

export function loadRecord(path: string): SoakRecordFile {
  if (!existsSync(path)) return { records: [] }
  const file = JSON.parse(readFileSync(path, 'utf8')) as SoakRecordFile
  if (!Array.isArray(file.records)) throw new Error(`${path} is not a soak record`)
  return file
}

/** Records every complete day after the last one, through `until` (a UTC day). Returns the new records. */
export async function recordDays(db: SoakDb, file: SoakRecordFile, markers: readonly ReleaseMarker[], opts: { from?: string; until: string; nowMs: number }): Promise<DayRecord[]> {
  const last = file.records.at(-1)
  let day = last ? nextDay(last.day) : opts.from
  if (day === undefined) throw new Error('soak: an empty record needs --from, the day of P4\'s house release')
  const added: DayRecord[] = []
  let prev = last ? { count: last.count } : null
  if (dayStartMs(day) > dayStartMs(opts.until)) return added
  if ((dayStartMs(opts.until) - dayStartMs(day)) / DAY_MS >= MAX_CATCH_UP) throw new Error(`soak: more than ${MAX_CATCH_UP} days to catch up; pass --from or --until`)
  for (; dayStartMs(day) <= dayStartMs(opts.until); day = nextDay(day)) {
    const rec = nextRecord(day, runChecks(await collectDay(db, day, opts.nowMs)), markers, prev)
    added.push(rec)
    prev = { count: rec.count }
  }
  return added
}

const arg = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

async function main(args: string[]): Promise<number> {
  const db = arg(args, '--db'), record = arg(args, '--record')
  if (!db || !record) { console.error('usage: node ops/soak/run.ts --db <house D1> --record <file> [--from YYYY-MM-DD] [--until YYYY-MM-DD] [--local --persist-to <dir>]'); return 2 }
  const persistTo = arg(args, '--persist-to')
  if (args.includes('--local') && !persistTo) { console.error('--local needs --persist-to <dir>'); return 2 }
  const nowMs = Date.now()
  const until = arg(args, '--until') ?? new Date(nowMs - DAY_MS).toISOString().slice(0, 10)
  const file = loadRecord(record)
  const added = await recordDays(wranglerDb(db, args.includes('--local') ? { persistTo: persistTo! } : null, arg(args, '--config')), file, readMarkers(process.cwd()), { from: arg(args, '--from'), until, nowMs })
  writeFileSync(record, JSON.stringify({ records: [...file.records, ...added] }, null, 2) + '\n')
  for (const r of added) {
    const bad = Object.entries(r.checks).filter(([, c]) => c.status !== 'clean').map(([k, c]) => `${k}: ${c.status}`)
    console.log(`${r.day} ${r.verdict} count=${r.count}${r.passed ? ' PASSED' : ''}${r.reasons.length ? ` (${r.reasons.join(', ')})` : ''}${bad.length ? ` [${bad.join('; ')}]` : ''}`)
  }
  if (added.length === 0) console.log(`nothing to record: the last recorded day is ${file.records.at(-1)?.day ?? 'none'}`)
  return 0
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1 })
}
