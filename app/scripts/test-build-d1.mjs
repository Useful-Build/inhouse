// The test build's local D1 (P2, p2-design section 10), in app/:
//   node scripts/test-build-d1.mjs migrate [--persist-to <dir>]   apply server/migrations/ (npm run test-build:migrate)
//   node scripts/test-build-d1.mjs seed [--persist-to <dir>]      seed it with the invented brand (npm run test-build:seed)
// <dir> is wrangler's persist root (`wrangler dev --persist-to`), default .wrangler/test-build. Both steps and the server
// must get the same one. The D1 lives under <dir>/v3, which is what a getPlatformProxy caller passes as
// `persist: { path: '<dir>/v3' }` (https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy).
// The seed refuses a <dir>/v3 with no migrated D1. It runs W2's server/seed/run.ts with `--persist-to <dir>`, and fails
// loud until that exists. Exit codes: 0 done, 1 the step failed or was refused, 2 usage. TEST_BUILD_SEED_RUNNER (a path
// relative to app/) runs another seed script in its place: scripts/test-build-d1.test.mjs uses it for a stub.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const usage = msg => {
  console.error(`test-build-d1: ${msg}\nUsage: node scripts/test-build-d1.mjs migrate|seed [--persist-to <dir>]`)
  process.exit(2)
}

const [step, ...rest] = process.argv.slice(2)
if (step !== 'migrate' && step !== 'seed') usage(`unknown step "${step ?? ''}".`)
let persistTo = '.wrangler/test-build'
let seen = false
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i]
  if (arg !== '--persist-to' && !arg.startsWith('--persist-to=')) usage(`unknown argument "${arg}".`)
  const value = arg === '--persist-to' ? rest[++i] : arg.slice('--persist-to='.length)
  if (seen) usage('--persist-to given more than once.')
  if (!value) usage('--persist-to needs a folder.')
  seen = true
  persistTo = value
}
const persist = resolve(appDir, persistTo)

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: appDir, stdio: 'inherit' })
  if (r.error) throw r.error
  process.exit(r.status ?? 1)
}

if (step === 'migrate') {
  run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', 'wrangler.test.jsonc', '--persist-to', persist])
}

// seed: the D1 must already be migrated (its `d1_migrations` table exists) under <dir>/v3.
const d1Dir = join(persist, 'v3', 'd1')
const files = existsSync(d1Dir)
  ? readdirSync(d1Dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith('.sqlite')).map(d => join(d.parentPath, d.name))
  : []
const migrated = files.filter(f => {
  const db = new DatabaseSync(f, { readOnly: true })
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").get() !== undefined
  } finally {
    db.close()
  }
})
if (migrated.length === 0) {
  console.error(`test-build:seed: no migrated D1 under ${join(persist, 'v3')}. Run \`npm run test-build:migrate -- --persist-to ${persistTo}\` first.`)
  process.exit(1)
}
const runner = process.env.TEST_BUILD_SEED_RUNNER || 'server/seed/run.ts'
if (!existsSync(resolve(appDir, runner))) {
  console.error(`test-build:seed: no seed yet (${runner}). W2 adds server/seed/run.ts, and this script then runs it.`)
  process.exit(1)
}
run('node', [runner, '--persist-to', persist])
