#!/usr/bin/env node
// The morning-check set's command line (p4-w3.md section 6). The orchestrator runs it, against the multi-config test build
// (product Worker and hub together) with the gateway pointed at the real model (a secret card), under the heavy lock:
//
//   node evals/morning-check/run.mjs --persist-dir <the test build's --persist-to dir> --base-url <the product Worker's origin> \
//     --out-dir evals/morning-check/results --sha <git sha> [--cases late-orders,clean-empty] [--model claude-sonnet-5-5] \
//     [--restart-cmd '<shell command that restarts the test build with SHOPIFY_SHOP set from the environment>']
//
// Environment: MORNING_CHECK_RELEASE_JWT, a `release` service token JWT for the test build (route 67 is release only).
// Per case it: restarts the test build with `SHOPIFY_SHOP=<the case's host>` (--restart-cmd, run with that variable set; the
// hosts are registered in the hub's test build, hub/testing/index.ts), seeds the routine's cursor and makes the 06:00 slot
// due (route 67), polls the stored rows (the persist dir's local D1 file, read only) until the slot ends or the case's
// deadline (default 20 min), grades it and writes `<out-dir>/<date>-<sha>.json`. The 06:00 slot is due only from 06:00 to
// 12:00 in the brand's zone (the catch-up window): run it then, or pass --trigger run-now to press Run now (route 54, needs a
// person's JWT in MORNING_CHECK_PERSON_JWT) instead.
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { META } from './expected.ts'
import { ROUTINE_ID, runAll } from './runner.ts'
import { writeResults } from './results.ts'

const { values: a } = parseArgs({
  options: {
    'persist-dir': { type: 'string' }, 'base-url': { type: 'string' }, 'out-dir': { type: 'string' }, sha: { type: 'string' }, cases: { type: 'string' },
    model: { type: 'string', default: 'claude-sonnet-5-5' }, 'restart-cmd': { type: 'string' }, trigger: { type: 'string', default: 'cursor' }, 'timeout-min': { type: 'string', default: '20' },
  },
})
for (const k of ['persist-dir', 'base-url', 'out-dir', 'sha']) if (!a[k]) throw new Error(`run.mjs: --${k} is required`)
const releaseJwt = process.env.MORNING_CHECK_RELEASE_JWT
if (!releaseJwt) throw new Error('run.mjs: MORNING_CHECK_RELEASE_JWT is not set')
const cases = a.cases ? a.cases.split(',').map(id => META.find(c => c.id === id) ?? (() => { throw new Error(`run.mjs: no case ${id}`) })()) : META

const post = async (path, body, jwt = releaseJwt) => {
  const r = await fetch(new URL(path, a['base-url']), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, Origin: new URL(a['base-url']).origin }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`run.mjs: POST ${path} answered ${r.status}`)
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
  newestSlot: async (routine, since) => withDb(db => db.prepare('SELECT slot_key, state, failure, result_text, turn_id, claimed_at_ms FROM routine_slots WHERE routine_id = ? AND claimed_at_ms >= ? ORDER BY local_date DESC, claimed_at_ms DESC LIMIT 1').get(routine, since) ?? null),
  items: async slot => withDb(db => db.prepare('SELECT item_json FROM today_items WHERE slot_key = ? ORDER BY rowid').all(slot).map(r => r.item_json)),
  tools: async turn => withDb(db => db.prepare('SELECT tool FROM tool_calls WHERE turn_id = ? ORDER BY n').all(turn).map(r => r.tool)),
}

let restarted = null
const env = {
  nowMs: () => Date.now(),
  async useShop(host) {
    if (!a['restart-cmd']) throw new Error('run.mjs: --restart-cmd is required (the shop is a var of the product Worker)')
    restarted?.kill()
    restarted = spawn(a['restart-cmd'], { shell: true, stdio: 'inherit', env: { ...process.env, SHOPIFY_SHOP: host.replace('.myshopify.com', '') }, detached: false })
    // Ready when the product Worker answers its health route.
    for (let i = 0; i < 120; i++) {
      if ((await fetch(new URL('/api/health', a['base-url'])).catch(() => null))?.ok) return
      await new Promise(r => setTimeout(r, 1000))
    }
    throw new Error('run.mjs: the test build did not come up')
  },
  async trigger(since) {
    if (a.trigger === 'run-now') return post(`/api/routines/${ROUTINE_ID}/run`, {}, process.env.MORNING_CHECK_PERSON_JWT ?? releaseJwt)
    await post('/api/ops/alarm', { action: 'seedCursor', routineId: ROUTINE_ID, checkedUntilMs: since - 2 * 3_600_000 })
    await post('/api/ops/alarm', { action: 'alarm', pokeTick: true })
  },
  nudge: () => post('/api/ops/alarm', { action: 'alarm' }),
  pause: () => new Promise(r => setTimeout(r, 2000)),
  reader,
  caseTimeoutMs: Number(a['timeout-min']) * 60_000,
}

try {
  const file = await runAll(env, cases, { date: new Date().toISOString().slice(0, 10), sha: a.sha, model: a.model })
  const path = writeResults(a['out-dir'], file)
  console.log(JSON.stringify({ path, summary: file.summary, failed: file.cases.filter(c => !c.verdict.pass).map(c => [c.id, c.verdict.reasons]) }, null, 2))
  process.exitCode = file.summary.thresholdMet ? 0 : 1
} finally {
  restarted?.kill()
}
