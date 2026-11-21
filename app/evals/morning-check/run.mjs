#!/usr/bin/env node
// The morning-check set's command line (p4-w3.md section 6). The orchestrator runs it, against the multi-config test build
// (product Worker and hub together) with the gateway pointed at the real model (a secret card), under the heavy lock:
//
//   node evals/morning-check/run.mjs --persist-dir <the test build's --persist-to dir> --base-url <the product Worker's origin> \
//     --out-dir evals/morning-check/results --sha <git sha> --issuer-key-file <the test issuer's private JWK> --aud <the brand app's Access aud> \
//     --restart-cmd '<shell command that restarts the test build with SHOPIFY_SHOP set from the environment>' \
//     [--cases late-orders,clean-empty] [--model claude-sonnet-5-5] [--timeout-min 20]
//
// Environment: MORNING_CHECK_RELEASE_JWT, a `release` service token JWT for the test build (route 67, the scheduler pass, is
// release only). The person who presses Run now is minted here with the test issuer (the seeded Admin by default; --sub and
// --email change it): no new test control.
// Per case it: restarts the test build with `SHOPIFY_SHOP=<the case's shop>` (--restart-cmd, run in its own process group; the
// old group is killed and awaited, its port seen down, the new build seen up, and its startup output must show
// `SHOPIFY_SHOP ... <shop>`, else the case is refused; --shop-pattern '{shop}' changes the pattern; the child gets no token; the
// shops are registered in the hub's test build, hub/testing/index.ts), presses Run now (route 54) with a fresh key, so the case's
// own manual slot `now|routine-morning-check|<key>` is made whatever the time or the day, nudges the scheduler (route 67), polls
// the stored rows (the persist dir's local D1 file, read only) until that slot ends or the case's deadline (default 20 min),
// grades it and rewrites `<out-dir>/<date>-<sha>.json` after each case. With --cases the result is `partial`: never a pass.
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { mintPerson } from '../../server/auth/test-issuer-mint.ts'
import { META } from './expected.ts'
import { Build } from './restart.ts'
import { openResults } from './results.ts'
import { ROUTINE_ID, runAll } from './runner.ts'
import { SEED_PEOPLE } from '../../server/seed/brand.ts'

const { values: a } = parseArgs({
  options: {
    'persist-dir': { type: 'string' }, 'base-url': { type: 'string' }, 'out-dir': { type: 'string' }, sha: { type: 'string' }, cases: { type: 'string' },
    model: { type: 'string', default: 'claude-sonnet-5-5' }, 'restart-cmd': { type: 'string' }, 'timeout-min': { type: 'string', default: '20' }, 'settle-min': { type: 'string', default: '2' },
    'shop-pattern': { type: 'string' }, 'restart-wait-sec': { type: 'string', default: '120' },
    'issuer-key-file': { type: 'string' }, aud: { type: 'string' }, sub: { type: 'string', default: SEED_PEOPLE.admin.subject }, email: { type: 'string', default: SEED_PEOPLE.admin.email },
  },
})
for (const k of ['persist-dir', 'base-url', 'out-dir', 'sha', 'issuer-key-file', 'aud']) if (!a[k]) throw new Error(`run.mjs: --${k} is required`)
const releaseJwt = process.env.MORNING_CHECK_RELEASE_JWT
if (!releaseJwt) throw new Error('run.mjs: MORNING_CHECK_RELEASE_JWT is not set')
const cases = a.cases ? a.cases.split(',').map(id => META.find(c => c.id === id) ?? (() => { throw new Error(`run.mjs: no case ${id}`) })()) : META

const privateJwk = JSON.parse(readFileSync(a['issuer-key-file'], 'utf8'))
/** The person who presses Run now: a fresh token each call (ten minutes), as the test issuer would mint it. */
const personJwt = () => mintPerson({ sub: a.sub, email: a.email, key: privateJwk, aud: a.aud })

const post = async (path, body, jwt) => {
  const r = await fetch(new URL(path, a['base-url']), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': jwt, Origin: new URL(a['base-url']).origin }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`run.mjs: POST ${path} answered ${r.status}: ${await r.text()}`)
}

/** The local D1 file under the persist dir that holds the routines tables. */
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
}

// A restart: the whole process group is signalled and awaited, the build's port seen down, the new build started in its own
// group, seen up, and its startup output must show the case's shop (restart.ts says why).
const SHOP_PATTERN = a['shop-pattern'] ?? 'SHOPIFY_SHOP[^\\n]*{shop}'
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const build = new Build({
  start(shop) {
    // The test build needs none of the runner's tokens, nor the test issuer's private key.
    const { MORNING_CHECK_RELEASE_JWT: _release, TEST_ISSUER_PRIVATE_JWK: _a1, TEST_ISSUER_PRIVATE_JWK_FILE: _a2, INHOUSE_TEST_ISSUER_PRIVATE_JWK: _a3, ...childEnv } = process.env
    const child = spawn(a['restart-cmd'], { shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...childEnv, SHOPIFY_SHOP: shop } })
    let out = ''
    const take = chunk => { process.stderr.write(chunk); out = (out + chunk).slice(-65536) }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const exited = new Promise(done => { child.on('exit', () => done()); child.on('error', () => done()) })
    return { pid: child.pid, exited, output: () => out }
  },
  killGroup(pid, signal) {
    try { process.kill(-pid, signal) } catch (e) { if (e?.code !== 'ESRCH') throw e }
  },
  // Any HTTP answer means the Worker is up (its health route wants a monitor token, so a 401 still counts).
  answers: async () => (await fetch(new URL('/api/health', a['base-url']), { signal: AbortSignal.timeout(2000) }).then(() => true, () => false)),
  pause: () => new Promise(r => setTimeout(r, 1000)),
  nowMs: () => Date.now(),
  waitMs: Number(a['restart-wait-sec']) * 1000,
  shopShown: (output, shop) => new RegExp(SHOP_PATTERN.replace('{shop}', escapeRe(shop))).test(output),
})

const env = {
  nowMs: () => Date.now(),
  async useShop(host) {
    if (!a['restart-cmd']) throw new Error('--restart-cmd is required (the shop is a var of the hub)')
    await build.restart(host.replace('.myshopify.com', ''))
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
  settleMs: Number(a['settle-min']) * 60_000,
}

const out = openResults(a['out-dir'], new Date().toISOString().slice(0, 10), a.sha)
try {
  const file = await runAll(env, cases, { date: new Date().toISOString().slice(0, 10), sha: a.sha, model: a.model }, f => out.write(f))
  console.log(JSON.stringify({ path: out.path, summary: file.summary, failed: file.cases.filter(c => !c.verdict.pass).map(c => [c.id, c.verdict.reasons]) }, null, 2))
  process.exitCode = file.summary.thresholdMet ? 0 : 1
} finally {
  await build.stop()
}
