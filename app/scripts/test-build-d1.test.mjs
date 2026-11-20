// scripts/test-build-d1.mjs's refusals, none of which runs wrangler: a second --persist-to, an unknown step or
// argument (usage, 2), and a seed on a folder with no migrated D1 (1, naming the folder). And its accept path: a seed on
// a migrated D1 under <dir>/v3 runs the seed runner (a stub here) with `--persist-to <dir>`. The migrated D1 is made with
// node:sqlite, the same module the script checks it with: the simplest way to write the one table it looks for without
// running wrangler.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const script = fileURLToPath(new URL('./test-build-d1.mjs', import.meta.url))
const run = (args, env = {}) => spawnSync('node', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

test.each([
  [['migrate', '--persist-to', 'a', '--persist-to', 'b'], /more than once/],
  [['seed', '--persist-to=a', '--persist-to', 'b'], /more than once/],
  [['migrate', '--persist-to'], /needs a folder/],
  [['migrate', '--other'], /unknown argument/],
  [['drop'], /unknown step/],
])('%j is a usage error (2)', (args, message) => {
  const r = run(args)
  expect(r.status).toBe(2)
  expect(r.stderr).toMatch(message)
})

test('seed refuses a folder with no migrated D1 (1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-build-d1-'))
  const r = run(['seed', '--persist-to', dir])
  expect(r.status).toBe(1)
  expect(r.stderr).toContain(`no migrated D1 under ${join(dir, 'v3')}`)
})

test('seed accepts a migrated D1 under <dir>/v3 and runs the seed runner with --persist-to <dir>', () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-build-d1-'))
  const d1 = join(dir, 'v3', 'd1', 'miniflare-D1DatabaseObject')
  mkdirSync(d1, { recursive: true })
  const db = new DatabaseSync(join(d1, 'db.sqlite'))
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT)')
  db.close()
  const stub = join(dir, 'seed-stub.mjs')
  writeFileSync(stub, "console.log('SEED ' + JSON.stringify(process.argv.slice(2)))")
  const r = run(['seed', '--persist-to', dir], { TEST_BUILD_SEED_RUNNER: stub })
  expect(r.stdout).toContain(`SEED ${JSON.stringify(['--persist-to', dir])}`)
  expect(r.status).toBe(0)
})
