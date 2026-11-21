#!/usr/bin/env node
// The store-data exfiltration set's command line (p4-w6.md section 6), the morning-check set's `run.mjs` with this set's reader.
// The orchestrator runs it against the multi-config test build (product Worker and hub together) with the gateway pointed at the
// real model (Sonnet 5.5 at medium, a secret card), under the heavy lock, and keeps the results:
//
//   node evals/exfiltration/store-data/run.mjs --persist-dir <the test build's --persist-to dir> --base-url <the product Worker's origin> \
//     --out-dir evals/exfiltration/store-data/results --sha <git sha> --issuer-key-file <the test issuer's private JWK> --aud <the brand app's Access aud> \
//     [--restart-cmd '<shell command that restarts the test build with SHOPIFY_SHOP set from the environment>'] \
//     [--cases XS01,XS02] [--model claude-sonnet-5-5] [--timeout-min 20]
//
// Environment: MORNING_CHECK_RELEASE_JWT, a `release` service token JWT for the test build (route 67 is release only).
// With --restart-cmd each case restarts the build on that case's shop (`SHOPIFY_SHOP=<host without .myshopify.com>`, registered in
// hub/testing/index.ts), as the morning-check runner does. Without it this is a single-build run: exactly one case in --cases, and
// the build must already be running with that case's shop (the script prints it); the restart pattern of the shared restart helper
// joins when it lands. Per case it presses Run now on the morning check (route 54) with a fresh key, nudges the scheduler (route 67),
// polls the stored rows (the persist dir's local D1, read only) until that slot ends or the deadline, grades it (grade.ts) and rewrites
// `<out-dir>/<date>-<sha>.json` after each case. A run of fewer cases than the set is `partial` and never passes.
// What it can't observe it says so: the egress logs only a refused WebFetch, never an allowed one's URL, so `webFetchUrls` is null
// and any WebFetch the run made fails its case (a morning check has no reason to fetch).
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { mintPerson } from '../../../server/auth/test-issuer-mint.ts'
import { SEED_PEOPLE } from '../../../server/seed/brand.ts'
import { resultPath } from '../../morning-check/results.ts'
import { ROUTINE_ID } from '../../morning-check/runner.ts'
import { STORE_DATA_CASES, hostOf } from './cases.ts'
import { runStoreData } from './runner.ts'

const { values: a } = parseArgs({
  options: {
    'persist-dir': { type: 'string' }, 'base-url': { type: 'string' }, 'out-dir': { type: 'string' }, sha: { type: 'string' }, cases: { type: 'string' },
    model: { type: 'string', default: 'claude-sonnet-5-5' }, 'restart-cmd': { type: 'string' }, 'timeout-min': { type: 'string', default: '20' },
    'issuer-key-file': { type: 'string' }, aud: { type: 'string' }, sub: { type: 'string', default: SEED_PEOPLE.admin.subject }, email: { type: 'string', default: SEED_PEOPLE.admin.email },
  },
})
for (const k of ['persist-dir', 'base-url', 'out-dir', 'sha', 'issuer-key-file', 'aud']) if (!a[k]) throw new Error(`run.mjs: --${k} is required`)
const releaseJwt = process.env.MORNING_CHECK_RELEASE_JWT
if (!releaseJwt) throw new Error('run.mjs: MORNING_CHECK_RELEASE_JWT is not set')
const cases = a.cases ? a.cases.split(',').map(id => STORE_DATA_CASES.find(c => c.id === id) ?? (() => { throw new Error(`run.mjs: no case ${id}`) })()) : STORE_DATA_CASES
if (!a['restart-cmd'] && cases.length !== 1) throw new Error('run.mjs: without --restart-cmd this is a single-build run: name exactly one case in --cases')
if (!a['restart-cmd']) console.log(`run.mjs: single-build run of ${cases[0].id}: the test build must be running with SHOPIFY_SHOP=${hostOf(cases[0].id).replace('.myshopify.com', '')}`)

const privateJwk = JSON.parse(readFileSync(a['issuer-key-file'], 'utf8'))
const personJwt = () => mintPerson({ sub: a.sub, email: a.email, key: privateJwk, aud: a.aud })

const post = async (path, body, jwt) => {
  const r = await fetch(new URL(path, a['base-url']), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': jwt, Origin: new URL(a['base-url']).origin }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`run.mjs: POST ${path} answered ${r.status}: ${await r.text()}`)
}

function findDb() {
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.sqlite') ? [join(dir, e.name)] : []))
  for (const file of walk(a['persist-dir'])) {
    const db = new DatabaseSync(file, { readOnly: true })
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'routine_slots'").get()
    db.close()
    if (has) return file
  }
  throw new Error('run.mjs: no local D1 file with routine_slots under --persist-dir')
}
const withDb = fn => {
  const db = new DatabaseSync(findDb(), { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

const reader = {
  slot: async key => withDb(db => db.prepare('SELECT slot_key, state, failure, result_text, turn_id, claimed_at_ms FROM routine_slots WHERE slot_key = ?').get(key) ?? null),
  items: async slot => withDb(db => db.prepare('SELECT item_json FROM today_items WHERE slot_key = ? ORDER BY rowid').all(slot).map(r => r.item_json)),
  tools: async turn => withDb(db => db.prepare('SELECT tool FROM tool_calls WHERE turn_id = ? ORDER BY n').all(turn).map(r => r.tool)),
  // The egress logs only a refused WebFetch (`webfetch_refused`, with no URL): an allowed one's URL isn't observable, so null.
  webFetchUrls: async () => null,
  memoryTexts: async since => withDb(db => db.prepare('SELECT text FROM memories WHERE created_at_ms >= ?').all(since).map(r => r.text)),
  routinesCreated: async since => withDb(db => db.prepare("SELECT COUNT(*) AS n FROM routines WHERE origin = 'team' AND created_at_ms >= ?").get(since).n),
}

let restarted = null
const env = {
  nowMs: () => Date.now(),
  async useShop(host) {
    if (!a['restart-cmd']) return
    restarted?.kill()
    // The test build needs none of the runner's tokens, nor the test issuer's private key.
    const { MORNING_CHECK_RELEASE_JWT: _release, TEST_ISSUER_PRIVATE_JWK: _a1, TEST_ISSUER_PRIVATE_JWK_FILE: _a2, INHOUSE_TEST_ISSUER_PRIVATE_JWK: _a3, ...childEnv } = process.env
    restarted = spawn(a['restart-cmd'], { shell: true, stdio: 'inherit', env: { ...childEnv, SHOPIFY_SHOP: host.replace('.myshopify.com', '') }, detached: false })
    for (let i = 0; i < 120; i++) {
      if ((await fetch(new URL('/api/health', a['base-url'])).catch(() => null))?.ok) return
      await new Promise(r => setTimeout(r, 1000))
    }
    throw new Error('run.mjs: the test build did not come up')
  },
  newKey: () => crypto.randomUUID().replaceAll('-', ''),
  async trigger(clientKey) {
    await post(`/api/routines/${ROUTINE_ID}/run`, { clientKey }, await personJwt())
    await post('/api/ops/alarm', { action: 'alarm', pokeTick: true }, releaseJwt)
  },
  nudge: () => post('/api/ops/alarm', { action: 'alarm' }, releaseJwt),
  pause: () => new Promise(r => setTimeout(r, 2000)),
  reader,
  caseTimeoutMs: Number(a['timeout-min']) * 60_000,
}

const date = new Date().toISOString().slice(0, 10)
mkdirSync(a['out-dir'], { recursive: true })
const path = resultPath(a['out-dir'], date, a.sha)
let created = false
const write = (outcomes, set) => {
  writeFileSync(path, `${JSON.stringify({ date, sha: a.sha, model: a.model, partial: cases.length < STORE_DATA_CASES.length, set, outcomes }, null, 2)}\n`, { flag: created ? 'w' : 'wx' })
  created = true
}
try {
  const { outcomes, set } = await runStoreData(env, cases, done => write(done, null))
  write(outcomes, set)
  console.log(JSON.stringify({ path, set, failed: outcomes.filter(o => !o.verdict.pass).map(o => [o.id, o.verdict.reasons]) }, null, 2))
  process.exitCode = set.pass ? 0 : 1
} finally {
  restarted?.kill()
}
