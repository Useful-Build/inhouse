// The Watch soak's daily driver (P8a K). Collects each UTC day after the last recorded one, up to yesterday, judges it,
// and appends the record to the soak record file: the day's verdict and the running count of consecutive clean days.
// A recorded day is never rewritten.
//
//   node ops/soak/run.ts --db <house D1 name or binding> --record <soak-record.json> --releases <releases.json>
//                        [--from YYYY-MM-DD] [--until YYYY-MM-DD] [--local --persist-to <dir>]
//                        [--config <wrangler config with the D1 binding>] [--canary <file>]
//
// `--canary`: a file of the exact strings planted in the house data, one per line. With it the leak scan looks for
// those. The flag is optional, but a clean day needs it: without it the scan looks only for canary-shaped text, which
// house data never holds, so the guards check is missing (not clean). The guards check is also missing on a day with an
// allowed WebFetch, until the product records the fetched host per call (checks.ts).
// `--until` can't be later than the UTC day before now, and a day is deferred (not recorded) while a slot due in it is
// still inside its window or a catch-up could still be made.
//
// `--releases` is required (a missing flag is a usage error, never an empty list): a JSON array of house release
// markers, read strictly (releases.ts: a bad file exits 2). House releases run from the private ops repo, and so does
// this driver. The orchestrator appends a marker at each house release; the ops automation comes later.
//
// Needs `wrangler` signed in to the account that holds the house D1 (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
// Meant to run once a day from the private ops repo (the nightly's soak step is a workflow, a sensitive path that waits
// for Wasim's OK, so nothing here schedules it). Exit 0: the days were recorded, whatever their verdict. 1: failed. 2: usage.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { collectDay, dayPending } from './collect.ts'
import type { CollectOptions, SoakDb } from './collect.ts'
import { runChecks } from './checks.ts'
import { ReleasesError, parseReleases } from './releases.ts'
import type { DayEvidence, DayRecord, ReleaseMarker } from './types.ts'
import { dayStartMs, livePhases, nextDay, nextRecord } from './window.ts'

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

export interface RecordOptions extends CollectOptions {
  from?: string
  until: string
  nowMs: number
  /** Tests inject the day's evidence and the in-flight check. */
  collect?: (db: SoakDb, day: string, nowMs: number, opts: CollectOptions) => Promise<DayEvidence>
  pending?: (db: SoakDb, day: string, nowMs: number) => Promise<string | null>
}

/** Every recorded behaviour release is in its day's record, and every recorded day's live set agrees with the markers. Null when it does; else what disagrees. */
export function verifyRecord(file: SoakRecordFile, markers: readonly ReleaseMarker[]): string | null {
  const byDay = new Map(file.records.map(r => [r.day, r]))
  for (const m of markers) {
    if (!m.behaviour) continue
    const rec = byDay.get(new Date(m.atMs).toISOString().slice(0, 10))
    if (rec !== undefined && !rec.releases.includes(m.appSha)) return `the record for ${rec.day} doesn't list the behaviour release ${m.appSha}`
  }
  for (const rec of file.records) {
    // A record from before the driver wrote each day's live set has none to check.
    if (!Array.isArray(rec.live)) return `the record for ${rec.day} has no live phases: an older driver wrote it, so it can't be checked against the releases (record those days again into a new file with --from)`
    const want = [...livePhases(markers, rec.day)].sort().join(',')
    if (rec.live.join(',') !== want) return `the record for ${rec.day} has live phases [${rec.live.join(',')}] but the releases say [${want}]`
  }
  return null
}

/** Records every complete day after the last one, through `until` (a UTC day, at most yesterday). Returns the new records. */
export async function recordDays(db: SoakDb, file: SoakRecordFile, markers: readonly ReleaseMarker[], opts: RecordOptions): Promise<DayRecord[]> {
  const yesterday = new Date(dayStartMs(new Date(opts.nowMs).toISOString().slice(0, 10)) - DAY_MS).toISOString().slice(0, 10)
  if (dayStartMs(opts.until) > dayStartMs(yesterday)) throw new Error(`soak: --until ${opts.until} is later than the UTC day before now (${yesterday})`)
  const last = file.records.at(-1)
  let day = last ? nextDay(last.day) : opts.from
  if (day === undefined) throw new Error('soak: an empty record needs --from, the day of P4\'s house release')
  const added: DayRecord[] = []
  let prev = last ? { count: last.count } : null
  if (dayStartMs(day) > dayStartMs(opts.until)) return added
  if ((dayStartMs(opts.until) - dayStartMs(day)) / DAY_MS >= MAX_CATCH_UP) throw new Error(`soak: more than ${MAX_CATCH_UP} days to catch up; pass --from or --until`)
  const collect = opts.collect ?? collectDay, pending = opts.pending ?? dayPending
  for (; dayStartMs(day) <= dayStartMs(opts.until); day = nextDay(day)) {
    const why = await pending(db, day, opts.nowMs)
    if (why !== null) { console.log(`${day} deferred: ${why}`); break }
    const rec = nextRecord(day, runChecks(await collect(db, day, opts.nowMs, { canaries: opts.canaries })), markers, prev)
    added.push(rec)
    prev = { count: rec.count }
  }
  return added
}

const arg = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

export async function main(args: string[]): Promise<number> {
  const db = arg(args, '--db'), record = arg(args, '--record'), releases = arg(args, '--releases')
  if (!db || !record || !releases) { console.error('usage: node ops/soak/run.ts --db <house D1> --record <file> --releases <file> [--from YYYY-MM-DD] [--until YYYY-MM-DD] [--local --persist-to <dir>] [--config <file>] [--canary <file>]'); return 2 }
  const persistTo = arg(args, '--persist-to')
  if (args.includes('--local') && !persistTo) { console.error('--local needs --persist-to <dir>'); return 2 }
  let markers: ReleaseMarker[]
  try { markers = parseReleases(readFileSync(releases, 'utf8')) } catch (err) {
    if (err instanceof ReleasesError || (err as NodeJS.ErrnoException).code === 'ENOENT') { console.error(`soak: ${(err as Error).message}`); return 2 }
    throw err
  }
  const nowMs = Date.now()
  const yesterday = new Date(nowMs - DAY_MS).toISOString().slice(0, 10)
  const until = arg(args, '--until') ?? yesterday
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until > yesterday) { console.error(`soak: --until must be a UTC day no later than ${yesterday}`); return 2 }
  const file = loadRecord(record)
  const mismatch = verifyRecord(file, markers)
  if (mismatch !== null) { console.error(`soak: ${mismatch}`); return 2 }
  const canaryFile = arg(args, '--canary')
  const canaries = canaryFile ? readFileSync(canaryFile, 'utf8').split('\n').map(l => l.trim()).filter(Boolean) : []
  if (canaryFile && canaries.length === 0) { console.error('soak: the --canary file holds no canary'); return 2 }
  const added = await recordDays(wranglerDb(db, args.includes('--local') ? { persistTo: persistTo! } : null, arg(args, '--config')), file, markers, { from: arg(args, '--from'), until, nowMs, canaries })
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
