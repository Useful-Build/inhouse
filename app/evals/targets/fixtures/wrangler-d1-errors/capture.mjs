// Captures real `wrangler d1 execute --remote --json` output for API failures, against a local fake Cloudflare API (#710).
// No real account, token or network: the base URL is 127.0.0.1, the token and ids are made up. The answers are the D1 error
// codes and messages of https://developers.cloudflare.com/d1/observability/debug-d1/ (read 2026-11-28) and a 429 with a
// Retry-After header (https://developers.cloudflare.com/fundamentals/api/reference/limits/). Re-run on a wrangler upgrade:
//   node evals/targets/fixtures/wrangler-d1-errors/capture.mjs   (from app/; writes the .txt files beside this script)
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const outDir = path.dirname(new URL(import.meta.url).pathname)
const appDir = path.resolve(outDir, '../../../..')
const ACCOUNT = '0123456789abcdef0123456789abcdef'
const DB = '00000000-0000-4000-8000-000000000000'
const here = mkdtempSync(path.join(tmpdir(), 'wrangler-capture-'))
const config = path.join(here, 'wrangler.json')
writeFileSync(config, JSON.stringify({ name: 'capture', account_id: ACCOUNT, compatibility_date: '2026-11-01', d1_databases: [{ binding: 'DB', database_name: 'fake-db', database_id: DB }] }))

const scenarios = {
  'd1-overloaded-queued': { status: 503, body: { success: false, errors: [{ code: 7429, message: 'D1 DB is overloaded. Too many requests queued.' }], messages: [], result: null } },
  'd1-overloaded-too-long': { status: 503, body: { success: false, errors: [{ code: 7429, message: 'D1 DB is overloaded. Requests queued for too long.' }], messages: [], result: null } },
  'd1-network-lost': { status: 500, body: { success: false, errors: [{ code: 7500, message: 'Network connection lost.' }], messages: [], result: null } },
  'd1-reset-code-updated': { status: 500, body: { success: false, errors: [{ code: 7500, message: 'D1 DB reset because its code was updated.' }], messages: [], result: null } },
  'd1-transient-remote-node': { status: 500, body: { success: false, errors: [{ code: 7500, message: 'Cannot resolve D1 DB due to transient issue on remote node.' }], messages: [], result: null } },
  'rate-limited-429': { status: 429, headers: { 'retry-after': '5' }, body: { success: false, errors: [{ code: 971, message: 'Please wait and consider throttling your request speed' }], messages: [], result: null } },
  'gateway-502-html': { status: 502, html: '<html><head><title>502 Bad Gateway</title></head><body>Bad Gateway</body></html>' },
  'sqlite-error': { status: 400, body: { success: false, errors: [{ code: 7500, message: 'no such table: memories: SQLITE_ERROR' }], messages: [], result: null } },
  'auth-10000': { status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }], messages: [], result: null } },
  'auth-7403': { status: 403, body: { success: false, errors: [{ code: 7403, message: 'The given account is not valid or is not authorized to access this service' }], messages: [], result: null } },
  'db-not-found-7404': { status: 404, body: { success: false, errors: [{ code: 7404, message: 'Database not found' }], messages: [], result: null } },
  'cpu-limit-reset': { status: 500, body: { success: false, errors: [{ code: 7500, message: 'D1 DB exceeded its CPU time limit and was reset.' }], messages: [], result: null } },
}

const run = (port) => new Promise((resolve) => {
  const env = { PATH: process.env.PATH, HOME: path.join(here, 'home'), CLOUDFLARE_API_TOKEN: 'fake-token-for-capture', CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${port}/client/v4`, WRANGLER_SEND_METRICS: 'false', CI: '1' }
  const c = spawn('npx', ['--no-install', 'wrangler', 'd1', 'execute', 'fake-db', '--remote', '--config', config, '--json', '--yes', '--command', 'SELECT 1'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  c.stdout.on('data', (d) => { out += d })
  c.stderr.on('data', (d) => { err += d })
  c.on('close', (code) => resolve({ code, out, err }))
})

for (const [name, s] of Object.entries(scenarios)) {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    if (s.html) { res.writeHead(s.status, { 'content-type': 'text/html' }); res.end(s.html); return }
    res.writeHead(s.status, { 'content-type': 'application/json', ...(s.headers ?? {}) })
    res.end(JSON.stringify(s.body))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const r = await run(port)
  server.close()
  writeFileSync(path.join(outDir, `${name}.txt`), `exit ${r.code}\n--- stdout\n${r.out}--- stderr\n${r.err}`)
  console.log(name, 'exit', r.code, 'hits', hits.length, hits[0] ?? '')
}
// A refused connection: nothing listens on the port.
const probe = http.createServer()
await new Promise((r) => probe.listen(0, '127.0.0.1', r))
const deadPort = probe.address().port
probe.close()
const r = await run(deadPort)
writeFileSync(path.join(outDir, 'connection-refused.txt'), `exit ${r.code}\n--- stdout\n${r.out}--- stderr\n${r.err}`)
console.log('connection-refused exit', r.code)
