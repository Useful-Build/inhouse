// Run a command against the test build, outside Playwright (in app/, after `npm run build:product-test`):
//   node e2e/support/test-build/serve.ts -- npx vitest run src/agent/contract
// Makes this run's test issuer key, prepares a fresh local D1 (prepare.mjs), starts `wrangler dev` on the test build as
// playwright.config.ts does, runs the command with CONTRACT_REAL_ORIGIN (the brand app's origin) and the issuer key in its
// environment, then stops the server and exits with the command's code. CI's contract-suite step uses it.
import { execFileSync, spawn } from 'node:child_process'
import { TEST_BUILD_WORKER_CONFIG, appOrigin, testAccessConfig, testBuildPort, testIssuerJwks } from './issuer.ts'

const at = process.argv.indexOf('--')
const command = at === -1 ? [] : process.argv.slice(at + 1)
if (command.length === 0) {
  console.error('Usage: node e2e/support/test-build/serve.ts -- <command> [args...]')
  process.exit(2)
}

const jwks = testIssuerJwks()
execFileSync('node', ['e2e/support/test-build/prepare.mjs'], { stdio: 'inherit' })
const server = spawn('npx', [
  'wrangler', 'dev', '--config', TEST_BUILD_WORKER_CONFIG, '--port', String(testBuildPort()), '--persist-to', '.wrangler/test-build',
  '--var', `TEST_ISSUER_JWKS:${jwks}`, '--var', `INHOUSE_ACCESS:${JSON.stringify(testAccessConfig())}`,
], { stdio: ['ignore', 'pipe', 'inherit'], detached: true })
const stop = () => { if (server.pid && server.exitCode === null) process.kill(-server.pid, 'SIGTERM') }

// Ready when wrangler says so on stdout; an exit first is a failure. No timer: the CI job's timeout covers a hang.
await new Promise<void>((resolve, reject) => {
  let seen = ''
  server.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk)
    seen += chunk.toString()
    if (/Ready on /.test(seen)) resolve()
  })
  server.once('exit', code => reject(new Error(`wrangler dev exited (${code}) before it was ready.`)))
})

const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, CONTRACT_REAL_ORIGIN: appOrigin('brand') } })
const code = await new Promise<number>(resolve => child.once('exit', c => resolve(c ?? 1)))
stop()
process.exit(code)
