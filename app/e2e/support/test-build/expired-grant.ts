// A support grant that ended an hour ago, put in the test build's local D1 after the seed (prepare.mjs runs this file):
// the API specs use it to see the lazy `grant.expired` line, with no clock override anywhere on a request path. Its
// `expiry_logged` is 0, so the first request that reads grants or the audit log writes the line, once.
//   node e2e/support/test-build/expired-grant.ts [--persist-to <dir>]    (in app/, after migrate and seed)
// Goes through `wrangler d1 execute --local --persist-to`, the way the migrate step does.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SEED_PEOPLE } from '../../../server/seed/brand.ts'

/** The seeded expired grant's id (`GrantIdSchema` shape). */
export const SEED_EXPIRED_GRANT_ID = 'g_seed_expired'
export const SEED_EXPIRED_GRANT_ENDED_AGO_MS = 3_600_000

/** The INSERT: made by the seeded Admin, running two hours ago, ended an hour ago by its own end time (never ended by hand). */
export function expiredGrantSql(nowMs: number): string {
  const ends = nowMs - SEED_EXPIRED_GRANT_ENDED_AGO_MS
  return `INSERT INTO support_grants (id, created_by, created_at_ms, ends_at_ms, ended_at_ms, ended_by, expiry_logged, rev, req_id)
    SELECT '${SEED_EXPIRED_GRANT_ID}', id, ${ends - 3_600_000}, ${ends}, NULL, NULL, 0, 1, NULL
    FROM members WHERE kind = 'person' AND subject = '${SEED_PEOPLE.admin.subject}'`
}

if ((import.meta as { main?: boolean }).main) {
  const args = process.argv.slice(2)
  const persist = args[0] === '--persist-to' && args[1] ? args[1] : '.wrangler/test-build'
  const appDir = fileURLToPath(new URL('../../../', import.meta.url))
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.test.jsonc', '--persist-to', persist, '--command', expiredGrantSql(Date.now())], { cwd: appDir, stdio: 'inherit' })
}
