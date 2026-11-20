// Run before the test build's `wrangler dev` starts (playwright.config.ts's test-build web server, in app/): a fresh
// local D1 under .wrangler/test-build, migrated, then seeded. Playwright starts its web servers before any global setup,
// so this runs in the server's own command, ahead of the server.
// The seed (W2's server/seed/run.ts) is skipped with a warning until it exists; `npm run test-build:seed` fails loud.
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('../../../', import.meta.url))
const persist = fileURLToPath(new URL('../../../.wrangler/test-build', import.meta.url))
rmSync(persist, { recursive: true, force: true })
const run = script => execFileSync('npm', ['run', script], { cwd: appDir, stdio: 'inherit' })
run('test-build:migrate')
if (existsSync(new URL('../../../server/seed/run.ts', import.meta.url))) run('test-build:seed')
else console.warn('test-build: no server/seed/run.ts yet (W2 adds it), so the local D1 is migrated but not seeded.')
// W6: one grant that already ended, for the API specs' expiry check (no clock hook on a request path).
execFileSync('node', ['e2e/support/test-build/expired-grant.ts'], { cwd: appDir, stdio: 'inherit' })
