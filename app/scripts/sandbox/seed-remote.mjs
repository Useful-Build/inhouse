// Seeds a sandbox D1 with the invented brand (server/seed/), for a per-PR test deployment or the candidate. Run in app/,
// after `wrangler d1 migrations apply <name> --remote`:
//   CF_SANDBOX_ACCOUNT_ID=<id> SBX_ZONE=<zone> node scripts/sandbox/seed-remote.mjs (--per-pr <N> | --candidate) \
//     --config <sandbox config> --database <name>
// The caller states the mode, as for the config check. In order, and nothing remote before the checks pass:
//   1. <name> must be PR N's D1 name (names.mjs's perPrNames), or for the candidate a sandbox name that is no PR's,
//      before anything else runs;
//   2. the config must pass check-product-config.mjs --sandbox in the same mode, and bind <name> as a D1 database. The
//      config's path is made absolute once, and that one path goes to the lock and to wrangler;
//   3. the seed renders to SQL here, with no network: server/migrations/ applied to an in-memory SQLite, then
//      server/seed/seed.ts's seedBrand run against it through a D1-shaped wrapper that records every write statement
//      that committed, in order. Replayed on a database migrated the same way, those writes leave the same rows (every id,
//      stamp and time is a bound value, so nothing is drawn again). Rendering uses server/db/sql.ts's renderStmt, as
//      server/seed/first-admin.ts does. The audit hash key is the config's vars.AUDIT_HASH_KEY or the environment's;
//   4. the remote database must have no people yet (the seed never runs twice): `wrangler d1 execute --remote --json`;
//   5. `wrangler d1 execute <name> --remote --file <sql> --yes`.
// Exit 0 seeded, 1 refused or failed, 2 usage. SEED_REMOTE_WRANGLER_FOR_TESTS (a .mjs path) replaces wrangler with a
// fake that records its calls (scripts/sandbox/seed-remote.test.mjs).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkSandboxConfig, parseSandboxMode, stripJsonc } from '../check-product-config.mjs'
import { SandboxNameError, assertCandidateName, perPrNames } from './names.mjs'

const appDir = fileURLToPath(new URL('../../', import.meta.url))
const MIGRATIONS = join(appDir, 'server/migrations')

/** The migrations as wrangler applies them: every .sql file in file-name order. */
export function applyMigrations(db) {
  for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
}

/** A fresh in-memory SQLite with foreign keys on, as D1 has them. */
export function freshDb() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

const isRead = sql => /^\s*SELECT\b/i.test(sql)

/**
 * A D1Database over a node:sqlite database: `prepare(sql).bind(...).first/all/run` and `batch` (one transaction).
 * Every statement that isn't a SELECT and committed is pushed to `writes` as `{ sql, params }`, in commit order; a
 * batch that fails rolls back and records nothing.
 */
export function recordingD1(db, writes) {
  const exec = (sql, params) => {
    const st = db.prepare(sql)
    const rows = st.columns().length > 0 ? st.all(...params).map(r => ({ ...r })) : (st.run(...params), [])
    const write = !isRead(sql)
    const changes = write ? db.prepare('SELECT changes() AS c').get().c : 0
    const last_row_id = db.prepare('SELECT last_insert_rowid() AS id').get().id
    return { rows, write, result: { results: rows, success: true, meta: { changes, last_row_id, changed_db: write && changes > 0 } } }
  }
  const single = (sql, params) => {
    const r = exec(sql, params)
    if (r.write) writes.push({ sql, params })
    return r
  }
  const statement = (sql, params) => ({
    sql,
    params,
    bind: (...next) => statement(sql, next),
    async first(column) {
      const row = single(sql, params).rows[0]
      if (row === undefined) return null
      return column === undefined ? row : row[column]
    },
    async all() { return single(sql, params).result },
    async run() { return single(sql, params).result },
  })
  return {
    prepare: sql => statement(sql, []),
    async batch(stmts) {
      const staged = []
      db.exec('BEGIN')
      try {
        const results = stmts.map(s => {
          const r = exec(s.sql, s.params)
          if (r.write) staged.push({ sql: s.sql, params: s.params })
          return r.result
        })
        db.exec('COMMIT')
        writes.push(...staged)
        return results
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
    async exec() { throw new Error('recordingD1: exec is not supported (the stores never call it)') },
  }
}

/** The seed's write statements as SQL lines, and the database they were recorded on (for tests). */
export async function renderSeedSql({ hashKey, nowMs }) {
  const { openStores } = await import(pathToFileURL(join(appDir, 'server/db/stores.ts')).href)
  const { seedBrand } = await import(pathToFileURL(join(appDir, 'server/seed/seed.ts')).href)
  const { renderStmt } = await import(pathToFileURL(join(appDir, 'server/db/sql.ts')).href)
  const db = freshDb()
  applyMigrations(db)
  const writes = []
  const d1 = recordingD1(db, writes)
  const seeded = await seedBrand(d1, openStores({ DB: d1, FILES: undefined, AUDIT_HASH_KEY: hashKey }), nowMs)
  // renderStmt ends each statement with its own ';'.
  return { sql: writes.map(w => renderStmt(w)), seeded, db }
}

const usageText = 'usage: CF_SANDBOX_ACCOUNT_ID=<id> SBX_ZONE=<zone> node scripts/sandbox/seed-remote.mjs (--per-pr <N> | --candidate) --config <sandbox config> --database <name>'
class Usage extends Error {}
class Refused extends Error {}

function parseArgs(all) {
  let mode
  let argv
  try { ({ mode, rest: argv } = parseSandboxMode(all)) } catch (err) { throw new Usage(err.message) }
  const flags = { mode }
  for (let i = 0; i < argv.length; i += 2) {
    const name = /^--(config|database)$/.exec(argv[i])?.[1]
    if (!name || Object.hasOwn(flags, name) || i + 1 >= argv.length) throw new Usage(`unexpected argument ${JSON.stringify(argv[i])}`)
    flags[name] = argv[i + 1]
  }
  if (flags.config === undefined || flags.database === undefined) throw new Usage('give --config and --database')
  return flags
}

function wrangler(args) {
  const fake = process.env.SEED_REMOTE_WRANGLER_FOR_TESTS
  const [cmd, pre] = fake ? [process.execPath, [fake]] : ['npx', ['--no-install', 'wrangler']]
  const r = spawnSync(cmd, [...pre, ...args], { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Refused(`wrangler ${args.slice(0, 2).join(' ')} exited ${r.status}`)
  return r.stdout
}

async function main(argv) {
  const { mode, config: givenPath, database } = parseArgs(argv)
  // 1. The name first: nothing else runs for a name outside this mode's.
  if (mode.perPr !== undefined) {
    if (database !== perPrNames(mode.perPr).d1) throw new Refused(`${JSON.stringify(database)} is not PR ${mode.perPr}'s D1 name (${perPrNames(mode.perPr).d1})`)
  } else {
    try { assertCandidateName(database) } catch (err) {
      if (err instanceof SandboxNameError) throw new Refused(err.message)
      throw err
    }
  }
  const configPath = resolve(givenPath)
  // 2. The config passes the lock and binds this database.
  let config
  try { config = JSON.parse(stripJsonc(readFileSync(configPath, 'utf8'))) } catch (err) { throw new Usage(`can't read ${configPath} as JSONC: ${err.message}`) }
  let failures
  try {
    failures = checkSandboxConfig(config, { accountId: process.env.CF_SANDBOX_ACCOUNT_ID, zone: process.env.SBX_ZONE, mode, configDir: dirname(configPath) })
  } catch (err) {
    if (err instanceof SandboxNameError) throw new Usage(err.message)
    throw err
  }
  if (failures.length) throw new Refused(`${configPath} fails check-product-config --sandbox:\n${failures.map(f => `  - ${f}`).join('\n')}`)
  if (!(config.d1_databases ?? []).some(d => d?.database_name === database)) throw new Refused(`${configPath} binds no D1 named ${database}`)
  const hashKey = config.vars?.AUDIT_HASH_KEY ?? process.env.AUDIT_HASH_KEY
  if (!hashKey) throw new Usage('no AUDIT_HASH_KEY in the config\'s vars or the environment')
  // 3. Render with no network.
  const { sql } = await renderSeedSql({ hashKey, nowMs: Date.now() })
  const file = join(mkdtempSync(join(tmpdir(), 'seed-remote-')), 'seed.sql')
  writeFileSync(file, `${sql.join('\n')}\n`)
  const remote = ['d1', 'execute', database, '--remote', '--config', configPath]
  // 4. Never twice.
  const out = wrangler([...remote, '--json', '--command', "SELECT COUNT(*) AS n FROM members WHERE kind = 'person'"])
  let people
  try { people = JSON.parse(out)[0].results[0].n } catch { throw new Refused('could not read the remote people count') }
  if (people !== 0) throw new Refused(`${database} already has ${people} people: seed only a freshly migrated database`)
  // 5. Seed.
  wrangler([...remote, '--file', file, '--yes'])
  console.log(`seed-remote: seeded ${database} (${sql.length} statements)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(err => {
    if (err instanceof Usage) {
      console.error(`seed-remote: ${err.message}\n${usageText}`)
      process.exitCode = 2
    } else {
      console.error(`seed-remote: refused or failed: ${err instanceof Refused ? err.message : err?.stack ?? err}`)
      process.exitCode = 1
    }
  })
}
