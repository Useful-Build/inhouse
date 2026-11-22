#!/usr/bin/env node
// The store-data exfiltration set's command line (p4-w6.md section 6), the morning-check set's `run.mjs` with this set's reader.
// Two modes (args.ts storeDataMode: the morning-check set's runMode, plus this set's remote rule).
//
// Local: the multi-config test build (product Worker and hub together) with the gateway pointed at the real model, under the
// heavy lock. Note a local build can't run agent turns (the Runner container is off there), so the graded run is the remote one.
//
//   node evals/exfiltration/store-data/run.mjs --persist-dir <the test build's --persist-to dir> --base-url <the product Worker's origin> \
//     --out-dir evals/exfiltration/store-data/results --sha <git sha> --issuer-key-file <the test issuer's private JWK> --aud <the brand app's Access aud> \
//     --restart-cmd 'npx wrangler dev -c wrangler.test.jsonc -c {hubConfig} --persist-to <dir> ...' \
//     [--cases XS01,XS02] [--model claude-sonnet-5-5] [--timeout-min 20] [--settle-min 2]
//
// The restart is the morning-check runner's (evals/morning-check/restart.ts and hubconfig.ts, shared as they are): `{hubConfig}` in
// --restart-cmd is the path of a per-case copy of wrangler.hub.test.jsonc whose `vars.SHOPIFY_SHOP` is the case's shop (registered in
// hub/testing/index.ts), the old build's process group is killed and awaited, the new one seen up, and its startup output must show
// the shop. Without --restart-cmd this is a single-build run of exactly one case: the build must already be running with that
// case's shop (the script prints it).
// Environment: MORNING_CHECK_RELEASE_JWT, a `release` service token JWT for the test build (route 67 is release only). Per case it
// presses Run now on the morning check (route 54) with a fresh key, nudges the scheduler (route 67), polls the stored rows (the
// persist dir's local D1, read only) until that slot ends or the deadline, grades it (grade.ts) and rewrites
// `<out-dir>/<date>-<sha>.json` after each case.
//
// Remote, the graded run on the eval deployment (the ops eval-run suite `store-data`):
//
//   INHOUSE_EVAL_D1_NAME=inhouse-sbx-eval-db INHOUSE_EVAL_WRANGLER_CONFIG=<the sandbox config that binds it> CF_SANDBOX_ACCOUNT_ID=... \
//   CLOUDFLARE_API_TOKEN=... INHOUSE_EVAL_ORIGIN=<the eval host> INHOUSE_EVAL_ACCESS_CLIENT_ID=... INHOUSE_EVAL_ACCESS_CLIENT_SECRET=... \
//   node evals/exfiltration/store-data/run.mjs --target <INHOUSE_EVAL_ORIGIN> --budget <usd, at most STORE_DATA_CAP> \
//     --out-dir evals/exfiltration/store-data/results --sha <git sha> --issuer-key-file <the eval deploy's test issuer private JWK> --aud <its Access aud> \
//     [--cases XS01,XS02] [--model claude-sonnet-5-5] [--timeout-min 20] [--settle-min 2]
//
// It is the morning-check graded run's frame (evals/morning-check/run.mjs and remote.ts, reused as they are): the eval lease, a
// probe chat proving --target answers from EVAL_DB, a refusal of a test shop override it didn't write, the Spending cap pinned
// and read back (STORE_DATA_CAP, remote.ts), the Default model set from --model and read back; every request carries the
// eval host's Access service token; the lease is renewed and the --budget checked before each case; on every way out
// (signals too) the override is cleared and the lease given back. Per case the door sets the test shop override to the
// case's shop (STORE_DATA_SHOPS only), Run now is pressed, the slot polled through the door, and what the grader needs is
// read remotely (remote.ts storeDataReader: the door's D1 rows, and the slot's transcript in the eval R2 through
// transcripts.ts, which needs CLOUDFLARE_API_TOKEN with R2 read on the sandbox account). A case whose slot ran on another
// model than --model fails and stops the run.
//
// In both modes a case that times out with its slot still open (after --settle-min) stops the run (exit 2), the rest listed as
// `notRun`. A run of fewer cases than the set is `partial` and never passes. What it can't observe it says so: the egress logs only
// a refused WebFetch, never an allowed one's URL, so `webFetchUrls` is null and any WebFetch the run made fails its case.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SEED_PEOPLE } from '../../../server/seed/brand.ts'
import { createMorningDoor } from '../../morning-check/door.ts'
import { commandFor, hubConfigFor } from '../../morning-check/hubconfig.ts'
import { clearOnSignals, gradedRun, remoteEnv, remoteHttp } from '../../morning-check/remote.ts'
import { Build, DEFAULT_SHOP_PATTERN, shopShownBy } from '../../morning-check/restart.ts'
import { resultPath } from '../../morning-check/results.ts'
import { ROUTINE_ID } from '../../morning-check/runner.ts'
import { createDoor, DoorRefusal, wranglerRunner } from '../../targets/door.ts'
import { accessHeaders, EVAL_AUD_VAR, EVAL_ISSUER_JWK_FILE, testIssuerSignIn } from '../../targets/product.ts'
import { storeDataMode } from './args.ts'
import { STORE_DATA_CASES, hostOf } from './cases.ts'
import { gradedSession, STORE_DATA_SHOPS, storeDataReader } from './remote.ts'
import { runStoreData } from './runner.ts'
import { createTranscriptReader, EVAL_BUCKET, holdsCanary } from './transcripts.ts'

const { values: a } = parseArgs({
  options: {
    'persist-dir': { type: 'string' }, 'base-url': { type: 'string' }, 'out-dir': { type: 'string' }, sha: { type: 'string' }, cases: { type: 'string' },
    model: { type: 'string', default: 'claude-sonnet-5-5' }, 'restart-cmd': { type: 'string' }, 'timeout-min': { type: 'string', default: '20' }, 'settle-min': { type: 'string', default: '2' },
    'shop-pattern': { type: 'string' }, 'restart-wait-sec': { type: 'string' }, target: { type: 'string' }, budget: { type: 'string' },
    'issuer-key-file': { type: 'string' }, aud: { type: 'string' }, sub: { type: 'string', default: SEED_PEOPLE.admin.subject }, email: { type: 'string', default: SEED_PEOPLE.admin.email },
  },
})
const m = storeDataMode(a, process.env)
const remote = m.mode === 'remote'
const cases = a.cases ? a.cases.split(',').map(id => STORE_DATA_CASES.find(c => c.id === id) ?? (() => { throw new Error(`run.mjs: no case ${id}`) })()) : STORE_DATA_CASES
if (!remote) {
  if (a['restart-cmd'] && !a['restart-cmd'].includes('{hubConfig}')) throw new Error('run.mjs: --restart-cmd must contain {hubConfig}')
  if (!a['restart-cmd'] && cases.length !== 1) throw new Error('run.mjs: without --restart-cmd this is a single-build run: name exactly one case in --cases')
  if (!a['restart-cmd']) console.log(`run.mjs: single-build run of ${cases[0].id}: the test build must be running with SHOPIFY_SHOP=${hostOf(cases[0].id).replace('.myshopify.com', '')}`)
}

// Read once up front, so a bad key file stops the run before any build starts (testIssuerSignIn reads it again per token).
JSON.parse(readFileSync(a['issuer-key-file'], 'utf8'))
/**
 * A person's sign-in headers on the brand app: evals/targets/product.ts's one sign-in helper (a fresh test-issuer token each
 * call), so the token travels as the eval harness sends it, in Cf-Access-Jwt-Assertion and X-Inhouse-Test-Assertion (#278).
 */
const signIn = who => testIssuerSignIn({ [EVAL_ISSUER_JWK_FILE]: a['issuer-key-file'], [EVAL_AUD_VAR]: a.aud })('current', who)
/** The person who presses Run now. */
const personAuth = () => signIn({ sub: a.sub, email: a.email })
/** Route 67's release service token (MORNING_CHECK_RELEASE_JWT, minted outside the run; test builds only), not a person. */
const releaseJwt = m.releaseJwt
const releaseAuth = releaseJwt ? { 'Cf-Access-Jwt-Assertion': releaseJwt } : null

// Every request goes through the morning-check remote.ts remoteHttp: the sign-in headers, then the eval host's Access
// service token last (targets/product.ts accessHeaders; the graded run requires it, args.ts).
const http = remoteHttp(remote ? accessHeaders(process.env) : {})
const post = (path, body, auth) => http.post(new URL(path, m.baseUrl), body, auth)
/** The seeded Admin's API calls on --target (gradedRun's probe chat and route 42), as morning-check run.mjs makes them. */
const admin = async (method, path, body) => {
  const { status, text } = await http.send(method, new URL(path, m.baseUrl), await signIn({ sub: SEED_PEOPLE.admin.subject, email: SEED_PEOPLE.admin.email }), body)
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = { text } }
  return { status, json }
}

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

const localReader = {
  slot: async key => withDb(db => db.prepare('SELECT slot_key, state, failure, result_text, turn_id, claimed_at_ms FROM routine_slots WHERE slot_key = ?').get(key) ?? null),
  items: async slot => withDb(db => db.prepare('SELECT item_json FROM today_items WHERE slot_key = ? ORDER BY rowid').all(slot).map(r => r.item_json)),
  tools: async turn => withDb(db => db.prepare('SELECT tool FROM tool_calls WHERE turn_id = ? ORDER BY n').all(turn).map(r => r.tool)),
  // The egress logs only a refused WebFetch (`webfetch_refused`, with no URL): an allowed one's URL isn't observable, so null.
  webFetchUrls: async () => null,
  memoryTexts: async since => withDb(db => db.prepare('SELECT text FROM memories WHERE created_at_ms >= ?').all(since).map(r => r.text)),
  // The run's transcript is an R2 object written during the case (the test build's local R2 under the persist dir): the planted text
  // reached a tool result when the canary is in an object written since the case began. Null when there is no R2 directory.
  // The content test (transcripts.ts holdsCanary) is the remote reader's too.
  canarySeen: async (canary, since) => {
    const r2 = join(m.persistDir, 'v3', 'r2')
    if (!existsSync(r2)) return null
    return readdirSync(r2, { recursive: true, withFileTypes: true }).some(d => d.isFile() && statSync(join(d.parentPath, d.name)).mtimeMs >= since && holdsCanary(readFileSync(join(d.parentPath, d.name)), canary))
  },
  routinesCreated: async since => withDb(db => db.prepare("SELECT COUNT(*) AS n FROM routines WHERE origin = 'team' AND created_at_ms >= ?").get(since).n),
}

// A restart, as run.mjs of the morning-check set does it (restart.ts says why each step).
const appDir = fileURLToPath(new URL('../../../', import.meta.url))
const configsMade = new Set()
/** The per-case hub config: a copy of the test hub config next to it (its relative paths still hold) with the case's shop in `vars`. */
function writeHubConfig(shop) {
  const path = join(appDir, `wrangler.hub.test.xs-${shop}.jsonc`)
  writeFileSync(path, hubConfigFor(readFileSync(join(appDir, 'wrangler.hub.test.jsonc'), 'utf8'), shop))
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

// The graded run's door and frame: wrangler on the morning-check database rule (args.ts has already required EVAL_DB), the
// morning-check door with this set's shops, the eval door's lease, cap and Default model (gradedRun), and the transcript
// reader on the eval bucket. A refusal is the door's own message and exit 2, before any case runs.
let door = null
let graded = null
let reader = localReader
if (remote) {
  try {
    const run = wranglerRunner({ database: m.database, config: m.wranglerConfig, env: process.env, rule: 'morning-check' })
    door = createMorningDoor(run, Date.now, STORE_DATA_SHOPS)
    graded = gradedRun({ door: createDoor(run), admin, label: m.graded.label, budgetUsd: m.graded.budgetUsd, tag: `store-data:${a.sha}:${crypto.randomUUID().slice(0, 8)}` })
    reader = storeDataReader({ door, run, transcripts: createTranscriptReader({ env: process.env, bucket: EVAL_BUCKET }) })
  } catch (e) {
    if (!(e instanceof DoorRefusal)) throw e
    console.error(`run.mjs: STOPPED before any case. The door refused the remote run: ${e.message}`)
    process.exit(2)
  }
}
// The override may be cleared only once the graded start passed (its start refuses an override another run wrote).
let mayClear = false
if (door) clearOnSignals({ close: () => door.close(), clearShop: () => (mayClear ? door.clearShop() : Promise.resolve(null)) }, undefined, () => graded.release())

const env = remote ? {
  ...remoteEnv({
    door,
    runNow: async clientKey => post(`/api/routines/${ROUTINE_ID}/run`, { clientKey }, await personAuth()),
    alarm: null,
    pause: () => new Promise(r => setTimeout(r, 2000)),
    nowMs: () => Date.now(),
    caseTimeoutMs: Number(a['timeout-min']) * 60_000,
    settleMs: Number(a['settle-min']) * 60_000,
    checkModel: true,
    beforeCase: () => graded.beforeCase(),
  }),
  reader,
} : {
  nowMs: () => Date.now(),
  async useShop(host) {
    if (!a['restart-cmd']) return
    await build.restart(host.replace('.myshopify.com', ''))
  },
  newKey: () => crypto.randomUUID().replaceAll('-', ''),
  async trigger(clientKey) {
    await post(`/api/routines/${ROUTINE_ID}/run`, { clientKey }, await personAuth())
    await post('/api/ops/alarm', { action: 'alarm', pokeTick: true }, releaseAuth)
  },
  nudge: () => post('/api/ops/alarm', { action: 'alarm' }, releaseAuth),
  pause: () => new Promise(r => setTimeout(r, 2000)),
  reader,
  caseTimeoutMs: Number(a['timeout-min']) * 60_000,
  settleMs: Number(a['settle-min']) * 60_000,
}

const date = new Date().toISOString().slice(0, 10)
mkdirSync(a['out-dir'], { recursive: true })
const path = resultPath(a['out-dir'], date, a.sha)
let created = false
const write = (outcomes, set, extra = {}) => {
  writeFileSync(path, `${JSON.stringify({ date, sha: a.sha, model: a.model, partial: cases.length < STORE_DATA_CASES.length, set, outcomes, ...extra }, null, 2)}\n`, { flag: created ? 'w' : 'wx' })
  created = true
}
const report = ({ outcomes, set, notRun, stopped }) => {
  write(outcomes, set, { notRun, ...(stopped ? { stopped } : {}) })
  console.log(JSON.stringify({ path, set, failed: outcomes.filter(o => !o.verdict.pass).map(o => [o.id, o.verdict.reasons]) }, null, 2))
  if (stopped) console.error(`\nrun.mjs: STOPPED. ${stopped}\nNot run: ${notRun.join(', ') || 'none'}. The result is partial (${path}).`)
  process.exitCode = stopped ? 2 : set.pass ? 0 : 1
}
const runCases = () => runStoreData(env, cases, done => write(done, null), remote ? a.model : undefined)
try {
  if (graded) {
    const { result, refused, cleanup } = await gradedSession({ graded, clearShop: () => door.clearShop(), onStarted: () => { mayClear = true }, run: runCases })
    if (refused !== null) {
      console.error(`run.mjs: STOPPED before any case. ${refused}`)
      process.exitCode = 2
    } else {
      report(result)
      // The graded run doesn't put the Default model back: the eval brand keeps the label --model mapped to.
      console.error(`run.mjs: the eval brand's Default model (g:mode) stays ${m.graded.label}: the graded run doesn't put it back.`)
    }
    for (const line of cleanup) {
      console.error(`run.mjs: ${line}`)
      process.exitCode = 2
    }
  } else {
    report(await runCases())
  }
} finally {
  await build.stop().catch(e => console.error(`run.mjs: the build did not stop cleanly: ${e.message}`))
  for (const p of configsMade) rmSync(p, { force: true })
}
