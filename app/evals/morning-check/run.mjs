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
//     [--cases ...] [--model ...] [--timeout-min 20] [--settle-min 2] [--model-setting Fast --inhouse-origin <its Inhouse app origin> --inhouse-aud <that app's Access aud>]
//
// The graded run (INHOUSE_EVAL_D1_NAME=inhouse-sbx-eval-db, the eval deploy; args.ts): its host is behind Access, so
// INHOUSE_EVAL_ACCESS_CLIENT_ID and _SECRET must both be set, and every request carries them (targets/product.ts
// accessHeaders) with the person's sign-in headers (testIssuerSignIn). It takes --budget <usd> (required, at most
// MORNING_CHECK_CAP), no --model-setting and no MORNING_CHECK_RELEASE_JWT. Before any case (remote.ts gradedRun) it takes
// the eval lease (refused while another eval run holds it), refuses a test shop override it didn't write, pins the eval
// brand's Spending cap to MORNING_CHECK_CAP and reads it back on route 42, and sets the brand's Default model to the
// label --model maps to (claude-sonnet-5-5 is "Fast"). Before each case it renews the lease and stops once the run has
// spent its --budget (route 42's month total, less the total at its start). On exit and on signals the lease is given
// back. The secret is never printed (remote.ts cuts it from any answer or error).
// --model names the model the results claim, but a routine runs on the brand's Default model (`g:mode`, fixed in the slot
// when it's made). So in remote mode each case's slot model is read through the door and kept as the case's `ranOn`; a
// case that ran on another model fails and the run stops (one case's spend at most): the backstop to the graded run's
// Default model write.
// --model-setting <label> (remote only, default none): before the first case, the brand's Default model (`g:mode`, route 12)
// is set to that label and read back. Only the Inhouse team writes `g:mode` (an Admin may write only `tm:<id>:on` there and
// gets 403 admin_read_only); it needs no grant (remote.ts SettingsApi says why). As watch-kit's setStage does, the seeded
// Admin ends live grants and opens one, the seeded Inhouse team member writes it on the build's Inhouse app
// (--inhouse-origin, --inhouse-aud), and the grants are ended again. The Admin calls are always SEED_PEOPLE.admin, never
// --sub/--email (those name the person who presses Run now).
// The scripted proof passes "Fast": routine turns run on the Default model (Opus when unset) and the scripted model
// answers only Fast. A real-model run leaves it out: the eval run picks its own model. The setting is not put back after
// the run (the brand's Default model stays changed), so use --model-setting only on a per-PR sandbox.
// No restart: per case the door (door.ts, wrangler d1 execute on the sandbox database) sets the test shop override the
// build's egress passes to the hub, Run now is pressed, the slot is polled through the door until it ends or the deadline,
// graded and written as above. The override is cleared before the first case, after every case and on exit. Without
// MORNING_CHECK_RELEASE_JWT there's no route 67 nudge (Run now pokes the scheduler itself). --target excludes every local
// option (--persist-dir, --base-url, --restart-cmd, --shop-pattern, --restart-wait-sec).
// One runner per deployment: the override is one row in the build's D1, so two runs against one deployment would set each
// other's shop. On a per-PR deployment a leftover row found at the start is removed and said loudly; the graded run refuses
// one instead. SIGINT and SIGTERM clear it before exiting.
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { META } from './expected.ts'
import { Build, DEFAULT_SHOP_PATTERN, shopShownBy } from './restart.ts'
import { commandFor, hubConfigFor } from './hubconfig.ts'
import { openResults } from './results.ts'
import { ROUTINE_ID, runAll } from './runner.ts'
import { runMode } from './args.ts'
import { createMorningDoor } from './door.ts'
import { clearOnSignals, ensureDefaultModel, gradedRun, remoteEnv, remoteHttp } from './remote.ts'
import { createDoor, DoorRefusal, wranglerRunner } from '../targets/door.ts'
import { accessHeaders, EVAL_AUD_VAR, EVAL_ISSUER_JWK_FILE, testIssuerSignIn } from '../targets/product.ts'
import { SEED_INHOUSE, SEED_PEOPLE } from '../../server/seed/brand.ts'

const { values: a } = parseArgs({
  options: {
    'persist-dir': { type: 'string' }, 'base-url': { type: 'string' }, 'out-dir': { type: 'string' }, sha: { type: 'string' }, cases: { type: 'string' },
    model: { type: 'string', default: 'claude-sonnet-5-5' }, 'restart-cmd': { type: 'string' }, 'timeout-min': { type: 'string', default: '20' }, 'settle-min': { type: 'string', default: '2' },
    'shop-pattern': { type: 'string' }, 'restart-wait-sec': { type: 'string' }, target: { type: 'string' }, 'model-setting': { type: 'string' }, 'inhouse-origin': { type: 'string' }, 'inhouse-aud': { type: 'string' }, budget: { type: 'string' },
    'issuer-key-file': { type: 'string' }, aud: { type: 'string' }, sub: { type: 'string', default: SEED_PEOPLE.admin.subject }, email: { type: 'string', default: SEED_PEOPLE.admin.email },
  },
})
const m = runMode(a, process.env)
const releaseJwt = m.releaseJwt
const cases = a.cases ? a.cases.split(',').map(id => META.find(c => c.id === id) ?? (() => { throw new Error(`run.mjs: no case ${id}`) })()) : META

// Read once up front, so a bad key file stops the run before anything is set (testIssuerSignIn reads it again per token).
JSON.parse(readFileSync(a['issuer-key-file'], 'utf8'))
/**
 * A person's sign-in headers on the app with Access aud `aud`: evals/targets/product.ts's one sign-in helper (a fresh
 * test-issuer token each call, ten minutes), so the token travels as the eval harness sends it: in Cf-Access-Jwt-Assertion
 * and X-Inhouse-Test-Assertion, which test and eval builds read first (#278: an Access app in front replaces the first).
 */
const signIn = (aud, who) => testIssuerSignIn({ [EVAL_ISSUER_JWK_FILE]: a['issuer-key-file'], [EVAL_AUD_VAR]: aud })('current', who)
/** The person who presses Run now. */
const personAuth = () => signIn(a.aud, { sub: a.sub, email: a.email })
/** Route 67's release service token (MORNING_CHECK_RELEASE_JWT, minted outside the run; test builds only), not a person. */
const releaseAuth = releaseJwt ? { 'Cf-Access-Jwt-Assertion': releaseJwt } : null

// Every request to the build goes through remote.ts remoteHttp: the sign-in headers, then the eval host's Access service
// token (targets/product.ts accessHeaders; args.ts allows it on a deployed build only, and requires it on the graded run).
const http = remoteHttp(m.mode === 'remote' && m.access ? accessHeaders(process.env) : {})
const post = (path, body, auth) => http.post(new URL(path, m.baseUrl), body, auth)
/**
 * One API call as one identity, signed in with signIn above (as e2e/api/kit.ts `actor` mints it): `who` is its sub and email, sent
 * to `origin` with that app's Access aud (and `Origin`). ensureDefaultModel reads the status and the JSON itself.
 */
const callAs = (who, origin, aud) => async (method, path, body) => {
  const auth = await signIn(aud, { sub: who.subject, email: who.email })
  const { status, text } = await http.send(method, new URL(path, origin), auth, body)
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = { text } }
  return { status, json }
}
/**
 * The Default model's writers (remote.ts SettingsApi): the seeded Admin on the brand app (reads, support grants) and the
 * seeded Inhouse team member on the build's Inhouse app (only the Inhouse team writes `g:mode`).
 */
const settingsApi = () => ({
  admin: callAs(SEED_PEOPLE.admin, new URL(m.baseUrl).origin, a.aud),
  inhouse: callAs(SEED_INHOUSE, m.modelSetting.inhouseOrigin, m.modelSetting.inhouseAud),
})

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

// The remote mode's door: wrangler on the morning-check set's database rule (evals/targets/door.ts
// assertMorningCheckDatabase: a PR's test database or EVAL_DB, never the candidate's). A refusal is the door's own message
// and exit 2, before any case runs, never a stack trace.
// On EVAL_DB (the graded run, args.ts) the same database's eval door (targets/door.ts createDoor) holds the eval lease,
// the cap and the Default model (remote.ts gradedRun), started before runAll: one runner per eval deployment.
let door = null
let graded = null
if (m.mode === 'remote') {
  try {
    const run = wranglerRunner({ database: m.database, config: m.wranglerConfig, env: process.env, rule: 'morning-check' })
    door = createMorningDoor(run)
    if (m.graded) {
      graded = gradedRun({
        door: createDoor(run), admin: callAs(SEED_PEOPLE.admin, new URL(m.baseUrl).origin, a.aud), label: m.graded.label, budgetUsd: m.graded.budgetUsd,
        tag: `morning-check:${a.sha}:${crypto.randomUUID().slice(0, 8)}`, nowMs: () => Date.now(),
      })
    }
  } catch (e) {
    if (!(e instanceof DoorRefusal)) throw e
    console.error(`run.mjs: STOPPED before any case. The door refused the remote run: ${e.message}`)
    process.exit(2)
  }
}
// An interrupted run closes the door (no more shops set), clears the override, gives the eval lease back (graded), then
// exits (130 on SIGINT, 143 on SIGTERM).
if (door) clearOnSignals(door, undefined, graded ? () => graded.release() : undefined)
if (graded) {
  try {
    await graded.start()
  } catch (e) {
    await graded.release().catch(r => console.error(`run.mjs: the eval lease could not be given back: ${r.message}`))
    console.error(`run.mjs: STOPPED before any case. ${e.message}`)
    process.exit(2)
  }
}
const env = door ? remoteEnv({
  door,
  runNow: async clientKey => post(`/api/routines/${ROUTINE_ID}/run`, { clientKey }, await personAuth()),
  alarm: releaseAuth ? body => post('/api/ops/alarm', body, releaseAuth) : null,
  pause: () => new Promise(r => setTimeout(r, 2000)),
  nowMs: () => Date.now(),
  caseTimeoutMs: Number(a['timeout-min']) * 60_000,
  settleMs: Number(a['settle-min']) * 60_000,
  checkModel: true,
  ...(graded ? { beforeCase: () => graded.beforeCase() } : {}),
  ...(m.modelSetting ? { defaultModel: () => ensureDefaultModel(settingsApi(), m.modelSetting.label) } : {}),
}) : {
  nowMs: () => Date.now(),
  async useShop(host) {
    if (!a['restart-cmd']) throw new Error('--restart-cmd is required (the shop is a var of the hub)')
    if (!a['restart-cmd'].includes('{hubConfig}')) throw new Error('--restart-cmd must contain {hubConfig}')
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

const out = openResults(a['out-dir'], new Date().toISOString().slice(0, 10), a.sha)
try {
  const file = await runAll(env, cases, { date: new Date().toISOString().slice(0, 10), sha: a.sha, model: a.model }, f => out.write(f))
  console.log(JSON.stringify({ path: out.path, summary: file.summary, failed: file.cases.filter(c => !c.verdict.pass).map(c => [c.id, c.verdict.reasons]) }, null, 2))
  if (file.stopped) console.error(`\nrun.mjs: STOPPED. ${file.stopped.reason}\nNot run: ${file.notRun.join(', ') || 'none'}. The result is partial (${out.path}).`)
  process.exitCode = file.stopped ? 2 : file.summary.thresholdMet ? 0 : 1
} finally {
  // runAll clears the override after every case; this covers a crash part way (a failure here is printed and fails the run).
  if (door) await door.clearShop().catch(e => { console.error(`run.mjs: the test shop override could not be cleared: ${e.message}`); process.exitCode = 2 })
  if (graded) await graded.release().catch(e => { console.error(`run.mjs: the eval lease could not be given back: ${e.message}`); process.exitCode = 2 })
  await build.stop().catch(e => console.error(`run.mjs: the build did not stop cleanly: ${e.message}`))
  for (const p of configsMade) rmSync(p, { force: true })
}
