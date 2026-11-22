// scripts/sandbox/seed-remote.mjs. Ways it could fail, written down first:
//  1. it calls wrangler (or renders) for a database outside the sandbox, or for a config the lock refuses, or one that
//     doesn't bind that database;
//  2. the rendered SQL, replayed on a freshly migrated database, leaves different rows than the seed wrote (a write not
//     recorded, a rolled-back batch recorded, a value rendered wrong);
//  3. it seeds a database that already has people, or seeds before checking;
//  4. it runs with a missing argument instead of stopping (exit 2);
//  5. (eval, p3-eval-observability rev 2 rec 2) in eval mode it seeds any database but the eval deployment's own, or the
//     candidate mode seeds the eval deployment's.
// Oracles: a fake wrangler that records every call; for 2, the literal seed facts (the brand's people, roles and
// statuses, and its audit lines by action, as server/seed/seed.test.ts counts them) checked on the REPLAYED database,
// and the replayed tables compared row for row with the database the seed wrote.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { applyMigrations, freshDb, recordingD1, renderSeedSql } from './seed-remote.mjs'

const script = fileURLToPath(new URL('./seed-remote.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../check-product-config-fixtures/sandbox/pass-per-pr.json', import.meta.url))
const evalFixture = fileURLToPath(new URL('../check-product-config-fixtures/sandbox/pass-eval.json', import.meta.url))
const ENV = { CF_SANDBOX_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', SBX_ZONE: 'zone.example.test' }
const dir = mkdtempSync(join(tmpdir(), 'seed-remote-test-'))

/** A fake wrangler: appends its argv (and, for --file, the file's text) to a log; answers the people count with `people`. */
function fakeWrangler(people) {
  const log = join(dir, `log-${Math.random().toString(16).slice(2)}.jsonl`)
  writeFileSync(log, '')
  const fake = join(dir, `wrangler-${Math.random().toString(16).slice(2)}.mjs`)
  writeFileSync(fake, `
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const at = args.indexOf('--file')
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, sql: at >= 0 ? readFileSync(args[at + 1], 'utf8') : null, auditKeyInEnv: 'AUDIT_HASH_KEY' in process.env }) + '\\n')
if (args.includes('--command')) console.log(JSON.stringify([{ results: [{ n: ${people} }], success: true }]))
`)
  return { fake, calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) }
}
const PR12 = ['--per-pr', '12']
const run = (args, fake, env = ENV, cwd = undefined) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...env, SEED_REMOTE_WRANGLER_FOR_TESTS: fake } })
const configWith = change => {
  const c = JSON.parse(readFileSync(fixture, 'utf8'))
  change(c)
  const file = join(dir, `config-${Math.random().toString(16).slice(2)}.json`)
  writeFileSync(file, JSON.stringify(c))
  return file
}

describe('refuses before any wrangler call (failure 1)', () => {
  for (const name of ['inhouse-app', 'live-product-db', 'wasimjalali-com', '', 'inhouse-sbx-pr12-db\n', 'INHOUSE-SBX-PR12-DB', 'xinhouse-sbx-pr12-db', 'inhouse-sbx-db', 'inhouse-sbx-pr13-db', 'inhouse-sbx-pr12-files']) {
    test(`a database that is not PR 12's: ${JSON.stringify(name)}`, () => {
      const w = fakeWrangler(0)
      const r = run([...PR12, '--config', fixture, '--database', name], w.fake)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("is not PR 12's D1 name (inhouse-sbx-pr12-db)")
      expect(w.calls()).toEqual([])
    })
  }
  for (const name of ['inhouse-sbx-pr12-db', 'live-product-db', 'inhouse-app', 'inhouse-sbx-eval-db']) {
    test(`a database that is not the candidate's: ${name}`, () => {
      const w = fakeWrangler(0)
      const r = run(['--candidate', '--config', fixture, '--database', name], w.fake)
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/is a per-PR name, not the candidate's|is not a sandbox name|is the eval deployment's name, not the candidate's/)
      expect(w.calls()).toEqual([])
    })
  }
  for (const name of ['inhouse-sbx-db', 'inhouse-sbx-pr12-db', 'inhouse-sbx-eval', 'inhouse-sbx-eval-files', 'live-product-db', 'INHOUSE-SBX-EVAL-DB', 'inhouse-sbx-eval-db\n']) {
    test(`eval mode: a database that is not the eval deployment's: ${JSON.stringify(name)} (failure 5)`, () => {
      const w = fakeWrangler(0)
      const r = run(['--eval', '--config', evalFixture, '--database', name], w.fake, { ...ENV, AUDIT_HASH_KEY: 'key-from-the-environment-0123456789' })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("is not the eval deployment's D1 name (inhouse-sbx-eval-db)")
      expect(w.calls()).toEqual([])
    })
  }
  test('PR 12\'s config in PR 13\'s mode', () => {
    const w = fakeWrangler(0)
    const r = run(['--per-pr', '13', '--config', fixture, '--database', 'inhouse-sbx-pr13-db'], w.fake)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('is not PR 13\'s worker name')
    expect(w.calls()).toEqual([])
  })
  test('a config the lock refuses (another account)', () => {
    const w = fakeWrangler(0)
    const r = run([...PR12, '--config', configWith(c => { c.account_id = 'fedcba9876543210fedcba9876543210' }), '--database', 'inhouse-sbx-pr12-db'], w.fake)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('account_id is missing or is not the sandbox account')
    expect(w.calls()).toEqual([])
  })
  test('a PR 12 database the config does not bind', () => {
    const w = fakeWrangler(0)
    const r = run([...PR12, '--config', configWith(c => { c.d1_databases = [] }), '--database', 'inhouse-sbx-pr12-db'], w.fake)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('binds no D1 named inhouse-sbx-pr12-db')
    expect(w.calls()).toEqual([])
  })
})

describe('usage (failure 4)', () => {
  test('exits 2 on a missing mode, missing or repeated arguments, a missing hash key or a missing sandbox environment, calling nothing', () => {
    const w = fakeWrangler(0)
    expect(run([], w.fake).status).toBe(2)
    expect(run(['--config', fixture, '--database', 'inhouse-sbx-pr12-db'], w.fake).status).toBe(2)
    expect(run(['--per-pr', '0', '--config', fixture, '--database', 'inhouse-sbx-pr12-db'], w.fake).status).toBe(2)
    expect(run([...PR12, '--database', 'inhouse-sbx-pr12-db'], w.fake).status).toBe(2)
    expect(run([...PR12, '--config', fixture, '--database'], w.fake).status).toBe(2)
    expect(run([...PR12, '--config', fixture, '--database', 'inhouse-sbx-pr12-db', '--database', 'inhouse-sbx-pr12-db'], w.fake).status).toBe(2)
    expect(run([...PR12, '--config', configWith(c => { delete c.vars.AUDIT_HASH_KEY }), '--database', 'inhouse-sbx-pr12-db'], w.fake).status).toBe(2)
    expect(run([...PR12, '--config', fixture, '--database', 'inhouse-sbx-pr12-db'], w.fake, {}).status).toBe(2)
    // A config with a comment: sandbox configs are plain JSON, read as the lock reads them.
    const commented = join(dir, 'commented.json')
    writeFileSync(commented, `// x\r"build":{"command":"echo pwned"},\n${readFileSync(fixture, 'utf8')}`)
    expect(run([...PR12, '--config', commented, '--database', 'inhouse-sbx-pr12-db'], w.fake).status).toBe(2)
    expect(w.calls()).toEqual([])
  })
})

describe('the remote steps (failure 3)', () => {
  test('checks the database is empty, then executes the rendered file on that database, remotely, with the config\'s absolute path', () => {
    const w = fakeWrangler(0)
    // A relative --config, from the fixture's own folder: wrangler (which runs in app/) must get the absolute path.
    const r = run([...PR12, '--config', 'pass-per-pr.json', '--database', 'inhouse-sbx-pr12-db'], w.fake, ENV, dirname(fixture))
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const calls = w.calls()
    expect(calls.map(c => c.args.slice(0, 6))).toEqual([
      ['d1', 'execute', 'inhouse-sbx-pr12-db', '--remote', '--config', fixture],
      ['d1', 'execute', 'inhouse-sbx-pr12-db', '--remote', '--config', fixture],
    ])
    expect(calls[0].args.slice(6)).toEqual(['--json', '--command', "SELECT COUNT(*) AS n FROM members WHERE kind = 'person'"])
    expect(calls[1].args.slice(6, 7)).toEqual(['--file'])
    expect(calls[1].args.slice(8)).toEqual(['--yes'])
    expect(calls[1].sql).toContain("'sam@example.test'")
    expect(calls[1].sql).toContain("'s:cap'")
    expect(calls[1].sql).not.toContain(';;')
    expect(calls[1].sql.trim().endsWith(';')).toBe(true)
  })
  test('eval mode seeds the eval deployment\'s own database, with the hash key from the environment (failure 5)', () => {
    const w = fakeWrangler(0)
    const r = run(['--eval', '--config', evalFixture, '--database', 'inhouse-sbx-eval-db'], w.fake, { ...ENV, AUDIT_HASH_KEY: 'key-from-the-environment-0123456789' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(w.calls().map(c => c.args.slice(0, 6))).toEqual([
      ['d1', 'execute', 'inhouse-sbx-eval-db', '--remote', '--config', evalFixture],
      ['d1', 'execute', 'inhouse-sbx-eval-db', '--remote', '--config', evalFixture],
    ])
    expect(w.calls().map(c => c.auditKeyInEnv)).toEqual([false, false])
  })
  test('wrangler never gets AUDIT_HASH_KEY in its environment, though the seed reads it from there', () => {
    const w = fakeWrangler(0)
    const r = run([...PR12, '--config', configWith(c => { delete c.vars.AUDIT_HASH_KEY }), '--database', 'inhouse-sbx-pr12-db'], w.fake, { ...ENV, AUDIT_HASH_KEY: 'key-from-the-environment-0123456789' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(w.calls().map(c => c.auditKeyInEnv)).toEqual([false, false])
  })
  test('refuses a database that already has people, without seeding', () => {
    const w = fakeWrangler(3)
    const r = run([...PR12, '--config', fixture, '--database', 'inhouse-sbx-pr12-db'], w.fake)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('already has 3 people')
    expect(w.calls()).toHaveLength(1)
  })
})

describe('the rendered SQL replays to the same rows (failure 2)', () => {
  const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name)
  // Rows sorted by their own JSON, not by rowid: P3 adds WITHOUT ROWID tables, and either order compares the same rows.
  const byJson = (x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)
  // 0221_morning_check.sql stamps its system routine with the time the migration ran (P4 W3), so two migrated databases differ in those three columns by design.
  const MIGRATION_TIME = ['checked_until_ms', 'created_at_ms', 'updated_at_ms']
  const dump = db => Object.fromEntries(tables(db).map(t => [t, db.prepare(`SELECT * FROM ${t}`).all().map(r => (t === 'routines' && r.id === 'routine-morning-check' ? { ...r, ...Object.fromEntries(MIGRATION_TIME.map(c => [c, 0])) } : { ...r })).sort(byJson)]))

  test('on a freshly migrated database: the brand as seed.test.ts counts it, and every table equal', async () => {
    const { sql, db: recorded } = await renderSeedSql({ hashKey: 'test-only-audit-hash-key-not-a-secret', nowMs: 1_800_000_000_000 })
    const replay = freshDb()
    applyMigrations(replay)
    replay.exec(sql.join('\n'))
    const people = replay.prepare("SELECT role, status, subject, email_norm FROM members WHERE kind = 'person' ORDER BY email_norm").all().map(r => ({ ...r }))
    expect(people).toEqual([
      { role: 'member', status: 'active', subject: 'seed-subject-dana', email_norm: 'dana@example.test' },
      { role: 'member', status: 'active', subject: 'seed-subject-leo', email_norm: 'leo@example.test' },
      { role: 'member', status: 'invited', subject: null, email_norm: 'priya@example.test' },
      { role: 'admin', status: 'active', subject: 'seed-subject-sam', email_norm: 'sam@example.test' },
    ])
    const actions = replay.prepare('SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY action').all().map(r => [r.action, r.n])
    expect(actions).toEqual([['inhouse.first_sign_in', 1], ['member.bound', 3], ['member.invited', 4], ['setting.changed', 7]])
    expect(replay.prepare("SELECT value_json FROM settings WHERE key = 's:cap'").get()).toBeDefined()
    expect(dump(replay)).toEqual(dump(recorded))
  })

  test('a batch that fails records nothing, and a committed one records only its writes', async () => {
    const db = freshDb()
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)')
    const writes = []
    const d1 = recordingD1(db, writes)
    await d1.batch([d1.prepare('INSERT INTO t (id, v) VALUES (?, ?)').bind(1, 'a'), d1.prepare('SELECT * FROM t')])
    await expect(d1.batch([d1.prepare('INSERT INTO t (id, v) VALUES (?, ?)').bind(2, 'b'), d1.prepare('INSERT INTO t (id, v) VALUES (?, ?)').bind(1, 'dup')])).rejects.toThrow()
    expect(await d1.prepare('SELECT v FROM t WHERE id = ?').bind(1).first('v')).toBe('a')
    expect((await d1.prepare('UPDATE t SET v = ? WHERE id = ?').bind('z', 9).run()).meta.changes).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get().n).toBe(1)
    expect(writes).toEqual([
      { sql: 'INSERT INTO t (id, v) VALUES (?, ?)', params: [1, 'a'] },
      { sql: 'UPDATE t SET v = ? WHERE id = ?', params: ['z', 9] },
    ])
  })
})
