#!/usr/bin/env node
// The morning-check set's command line (p4-w3.md section 6). The orchestrator runs it, against the multi-config test build
// (product Worker and hub together) with the gateway pointed at the real model (a secret card), under the heavy lock:
//
//   node evals/morning-check/run.mjs --persist-dir <the test build's --persist-to dir> --base-url <the product Worker's origin> \
//     --out-dir evals/morning-check/results --sha <git sha> --issuer-key-file <the test issuer's private JWK> --aud <the brand app's Access aud> \
//     --restart-cmd 'npx wrangler dev -c wrangler.test.jsonc -c {hubConfig} --persist-to <dir> ...' \
//     [--cases late-orders,clean-empty] [--model claude-sonnet-5-5] [--timeout-min 20] [--settle-min 2]
//
// `{hubConfig}` in --restart-cmd is required: the path of a per-case copy of wrangler.hub.test.jsonc (written next to it, so its
// relative paths hold, and removed at the end) whose `vars.SHOPIFY_SHOP` is the case's shop. A config `vars` value is the only
// kind wrangler dev prints (a --var, the environment and a local vars file print "(hidden)"), and the startup output must show it.
// Environment: MORNING_CHECK_RELEASE_JWT, a `release` service token JWT for the test build (route 67, the scheduler pass, is
// release only). The person who presses Run now is minted here with the test issuer (the seeded Admin by default; --sub and
// --email change it): no new test control.
// Per case it: restarts the test build with that config (run in its own process group; the old group is killed and awaited, its
// port seen down, the new build seen up, and its startup output must match --shop-pattern, default `SHOPIFY_SHOP\W{1,4}{shop}`
// with a right edge, else the case is refused; the child gets no token; the shops are registered in the hub's test build,
// hub/testing/index.ts), presses Run now (route 54) with a fresh key, so the case's own manual slot
// `now|routine-morning-check|<key>` is made whatever the time or the day, nudges the scheduler (route 67), polls the stored rows
// (the persist dir's local D1 file, read only) until that slot ends or the case's deadline (default 20 min), grades it and
// rewrites `<out-dir>/<date>-<sha>.json` after each case. With --cases the result is `partial`: never a pass. If a case times
// out and its slot doesn't settle within --settle-min, the run stops (exit 2): the slot stays open for up to 45 minutes and
// every later Run now would be refused, so the remaining cases are listed as `notRun`.
//
// Remote mode (a deployed test or eval build, where every turn gets its container; args.ts and remote.ts):
//
//   INHOUSE_EVAL_D1_NAME=inhouse-sbx-pr<N>-db INHOUSE_EVAL_WRANGLER_CONFIG=<the sandbox config that binds it> CF_SANDBOX_ACCOUNT_ID=... \
//   [MORNING_CHECK_RELEASE_JWT=<release token, test build only>] node evals/morning-check/run.mjs --target <the build's https origin> \
//     --out-dir evals/morning-check/results --sha <git sha> --issuer-key-file <that deploy's test issuer private JWK> --aud <its Access aud> \
//     [--cases ...] [--model ...] [--timeout-min 20] [--settle-min 2]
//
// No restart: per case the door (door.ts, wrangler d1 execute on the sandbox database) sets the test shop override the
// build's egress passes to the hub, Run now is pressed, the slot is polled through the door until it ends or the deadline,
// graded and written as above. The override is cleared before the first case, after every case and on exit. Without
// MORNING_CHECK_RELEASE_JWT there's no route 67 nudge (Run now pokes the scheduler itself). --target excludes every local
// option (--persist-dir, --base-url, --restart-cmd, --shop-pattern, --restart-wait-sec).
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { mintPerson } from '../../server/auth/test-issuer-mint.ts'
import { META } from './expected.ts'
import { Build, DEFAULT_SHOP_PATTERN, shopShownBy } from './restart.ts'
import { commandFor, hubConfigFor } from './hubconfig.ts'
import { openResults } from './results.ts'
import { ROUTINE_ID, runAll } from './runner.ts'
import { runMode } from './args.ts'
import { createMorningDoor } from './door.ts'
import { remoteEnv } from './remote.ts'
import { wranglerRunner } from '../targets/door.ts'
import { SEED_PEOPLE } from '../../server/seed/brand.ts'

const { values: a } = parseArgs({
  options: {
    'persist-dir': { type: 'string' }, 'base-url': { type: 'string' }, 'out-dir': { type: 'string' }, sha: { type: 'string' }, cases: { type: 'string' },
    model: { type: 'string', default: 'claude-sonnet-5-5' }, 'restart-cmd': { type: 'string' }, 'timeout-min': { type: 'string', default: '20' }, 'settle-min': { type: 'string', default: '2' },
    'shop-pattern': { type: 'string' }, 'restart-wait-sec': { type: 'string' }, target: { type: 'string' },
    'issuer-key-file': { type: 'string' }, aud: { type: 'string' }, sub: { type: 'string', default: SEED_PEOPLE.admin.subject }, email: { type: 'string', default: SEED_PEOPLE.admin.email },
  },
})
const m = runMode(a, process.env)
const releaseJwt = m.releaseJwt
const cases = a.cases ? a.cases.split(',').map(id => META.find(c => c.id === id) ?? (() => { throw new Error(`run.mjs: no case ${id}`) })()) : META

const privateJwk = JSON.parse(readFileSync(a['issuer-key-file'], 'utf8'))
/** The person who presses Run now: a fresh token each call (ten minutes), as the test issuer would mint it. */
const personJwt = () => mintPerson({ sub: a.sub, email: a.email, key: privateJwk, aud: a.aud })

const post = async (path, body, jwt) => {
  const r = await fetch(new URL(path, m.baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': jwt, Origin: new URL(m.baseUrl).origin }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`run.mjs: POST ${path} answered ${r.status}: ${await r.text()}`)
}

/** The local D1 file under the persist dir that holds the routines tables. */
function findDb() {
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.sqlite') ? [join(dir, e.name)] : []))
  for (const file of walk(m.persistDir)) {
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
const appDir = fileURLToPath(new URL('../../', import.meta.url))
const hubConfigText = readFileSync(join(appDir, 'wrangler.hub.test.jsonc'), 'utf8')
const configsMade = new Set()
/** The per-case hub config: a copy of the test hub config next to it (its relative paths still hold) with the case's shop in `vars`. */
function writeHubConfig(shop) {
  const path = join(appDir, `wrangler.hub.test.mc-${shop}.jsonc`)
  writeFileSync(path, hubConfigFor(hubConfigText, shop))
  configsMade.add(path)
  return path
}
const build = new Build({
  start(shop) {
    // The test build needs none of the runner's tokens, nor the test issuer's private key.
    const { MORNING_CHECK_RELEASE_JWT: _release, TEST_ISSUER_PRIVATE_JWK: _a1, TEST_ISSUER_PRIVATE_JWK_FILE: _a2, INHOUSE_TEST_ISSUER_PRIVATE_JWK: _a3, ...childEnv } = process.env
    const child = spawn(commandFor(a['restart-cmd'], writeHubConfig(shop)), { shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...childEnv, SHOPIFY_SHOP: shop } })
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
  answers: async () => (await fetch(new URL('/api/health', m.baseUrl), { signal: AbortSignal.timeout(2000) }).then(() => true, () => false)),
  pause: () => new Promise(r => setTimeout(r, 1000)),
  nowMs: () => Date.now(),
  waitMs: Number(a['restart-wait-sec'] ?? '120') * 1000,
  shopShown: shopShownBy(a['shop-pattern'] ?? DEFAULT_SHOP_PATTERN),
})

// The remote mode's door: wrangler on the sandbox database only (evals/targets/door.ts refuses any other).
const door = m.mode === 'remote' ? createMorningDoor(wranglerRunner({ database: m.database, config: m.wranglerConfig, env: process.env })) : null
const env = door ? remoteEnv({
  door,
  runNow: async clientKey => post(`/api/routines/${ROUTINE_ID}/run`, { clientKey }, await personJwt()),
  alarm: releaseJwt ? body => post('/api/ops/alarm', body, releaseJwt) : null,
  pause: () => new Promise(r => setTimeout(r, 2000)),
  nowMs: () => Date.now(),
  caseTimeoutMs: Number(a['timeout-min']) * 60_000,
  settleMs: Number(a['settle-min']) * 60_000,
}) : {
  nowMs: () => Date.now(),
  async useShop(host) {
    if (!a['restart-cmd']) throw new Error('--restart-cmd is required (the shop is a var of the hub)')
    if (!a['restart-cmd'].includes('{hubConfig}')) throw new Error('--restart-cmd must contain {hubConfig}')
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
  if (file.stopped) console.error(`\nrun.mjs: STOPPED. ${file.stopped.reason}\nNot run: ${file.notRun.join(', ') || 'none'}. The result is partial (${out.path}).`)
  process.exitCode = file.stopped ? 2 : file.summary.thresholdMet ? 0 : 1
} finally {
  // runAll clears the override after every case; this covers a crash part way (a failure here is printed and fails the run).
  if (door) await door.clearShop().catch(e => { console.error(`run.mjs: the test shop override could not be cleared: ${e.message}`); process.exitCode = 2 })
  await build.stop().catch(e => console.error(`run.mjs: the build did not stop cleanly: ${e.message}`))
  for (const p of configsMade) rmSync(p, { force: true })
}
