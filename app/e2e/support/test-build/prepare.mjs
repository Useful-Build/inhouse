// Run before the test build's `wrangler dev` starts (playwright.config.ts's test-build web server, in app/): a fresh
// local D1 under .wrangler/test-build, migrated, then seeded. Playwright starts its web servers before any global setup,
// so this runs in the server's own command, ahead of the server.
// A missing seed (server/seed/run.ts) fails loud in `npm run test-build:seed`.
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('../../../', import.meta.url))
const persist = fileURLToPath(new URL('../../../.wrangler/test-build', import.meta.url))
rmSync(persist, { recursive: true, force: true })
const run = script => execFileSync('npm', ['run', script], { cwd: appDir, stdio: 'inherit' })
run('test-build:migrate')
run('test-build:seed')
// W6: one grant that already ended, for the API specs' expiry check (no clock hook on a request path).
execFileSync('node', ['e2e/support/test-build/expired-grant.ts'], { cwd: appDir, stdio: 'inherit' })
