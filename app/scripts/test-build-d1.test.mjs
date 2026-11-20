// scripts/test-build-d1.mjs's refusals, none of which runs wrangler: a second --persist-to, an unknown step or
// argument (usage, 2), and a seed on a folder with no migrated D1 (1, naming the folder).
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const script = fileURLToPath(new URL('./test-build-d1.mjs', import.meta.url))
const run = (...args) => spawnSync('node', [script, ...args], { encoding: 'utf8' })

test.each([
  [['migrate', '--persist-to', 'a', '--persist-to', 'b'], /more than once/],
  [['seed', '--persist-to=a', '--persist-to', 'b'], /more than once/],
  [['migrate', '--persist-to'], /needs a folder/],
  [['migrate', '--other'], /unknown argument/],
  [['drop'], /unknown step/],
])('%j is a usage error (2)', (args, message) => {
  const r = run(...args)
  expect(r.status).toBe(2)
  expect(r.stderr).toMatch(message)
})

test('seed refuses a folder with no migrated D1 (1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-build-d1-'))
  const r = run('seed', '--persist-to', dir)
  expect(r.status).toBe(1)
  expect(r.stderr).toContain(`no migrated D1 under ${join(dir, 'v3')}`)
})
