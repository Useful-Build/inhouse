// Run a command against the test build, outside Playwright (in app/, after `npm run build:product-test`):
//   node e2e/support/test-build/serve.ts -- npx vitest run src/agent/contract
// Makes this run's test issuer key, prepares a fresh local D1 (prepare.mjs), starts `wrangler dev` on the test build as
// playwright.config.ts does, runs the command with CONTRACT_REAL_ORIGIN (the brand app's origin) and the issuer key in its
// environment (and the brand app's `aud`, for the contract suite's real target to sign in), then stops the server and exits with the command's code. CI's contract-suite step uses it.
import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { TEST_BUILD_HUB_CONFIG, TEST_BUILD_WORKER_CONFIG, appOrigin, testAccessConfig, testBuildPort, testIssuerJwks } from './issuer.ts'

const at = process.argv.indexOf('--')
const command = at === -1 ? [] : process.argv.slice(at + 1)
if (command.length === 0) {
  console.error('Usage: node e2e/support/test-build/serve.ts -- <command> [args...]')
  process.exit(2)
}

const jwks = testIssuerJwks()
execFileSync('node', ['e2e/support/test-build/prepare.mjs'], { stdio: 'inherit' })
const server = spawn('npx', [
  'wrangler', 'dev', '--config', TEST_BUILD_WORKER_CONFIG, '--config', TEST_BUILD_HUB_CONFIG, '--port', String(testBuildPort()), '--persist-to', '.wrangler/test-build',
  '--var', `TEST_ISSUER_JWKS:${jwks}`, '--var', `INHOUSE_ACCESS:${JSON.stringify(testAccessConfig())}`,
], { stdio: ['ignore', 'pipe', 'inherit'], detached: true })
const stop = () => { if (server.pid && server.exitCode === null) process.kill(-server.pid, 'SIGTERM') }
// The command, once started. It runs in its own process group too, so a signal reaches it and everything it started.
let child: ChildProcess | undefined
let signalled: number | undefined
// Ctrl+C or a CI cancel: signal the command (the main flow below then stops wrangler dev and exits with the command's
// code, or 130/143 if it was killed by the signal); before the command started, stop wrangler dev and exit 130/143.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    signalled = signal === 'SIGINT' ? 130 : 143
    if (child?.pid && child.exitCode === null && child.signalCode === null) { process.kill(-child.pid, signal); return }
    stop()
    process.exit(signalled)
  })
}

// Ready when wrangler says so on stdout. An exit first, or no "Ready on" by the deadline (a condition with an upper
// bound, not a sleep: it ends the moment wrangler is ready), fails with its output.
const READY_MS = 120_000
const deadline = AbortSignal.timeout(READY_MS)
let seen = ''
let ready = false
await new Promise<void>((resolve, reject) => {
  const late = () => reject(new Error(`wrangler dev wasn't ready within ${READY_MS / 1000} s.`))
  deadline.addEventListener('abort', late, { once: true })
  server.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk)
    // Kept only until ready (for the failure message); after that wrangler's output is passed through, not collected.
    if (ready) return
    seen += chunk.toString()
    if (/Ready on /.test(seen)) { ready = true; seen = ''; deadline.removeEventListener('abort', late); resolve() }
  })
  server.once('exit', code => { deadline.removeEventListener('abort', late); reject(new Error(`wrangler dev exited (${code}) before it was ready.`)) })
}).catch((err: Error) => {
  stop()
  console.error(`${err.message}\n--- wrangler dev output ---\n${seen}`)
  process.exit(1)
})

child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: true, env: { ...process.env, CONTRACT_REAL_ORIGIN: appOrigin('brand'), CONTRACT_REAL_BRAND_AUD: testAccessConfig().apps.find(a => a.name === 'brand')!.aud } })
const started = child
const code = await new Promise<number>(resolve => started.once('exit', c => resolve(c ?? signalled ?? 1)))
stop()
process.exit(code)
