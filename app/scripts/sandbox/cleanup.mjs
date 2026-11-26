// Deletes the per-PR test deployments of closed app PRs (sandbox-test-deploy-cleanup.yml: on PR close, a daily sweep and by hand). Moved from the private ops repo.
//   node scripts/sandbox/cleanup.mjs --app <app repo main checkout>/app [--dry-run]
// Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (must equal CF_SANDBOX_ACCOUNT_ID), CF_SANDBOX_ACCOUNT_ID, SBX_ZONE;
// GITHUB_TOKEN (optional, for the API rate limit; the app repo is public).
// It lists the account's Workers, custom domains, D1 databases, R2 buckets, container applications and registry images,
// finds every PR a per-PR name belongs to (app repo's names.mjs), reads each PR's state from GitHub, and deletes exactly the closed PRs' names
// (lib/teardown.mjs). A PR whose state it can't read is kept, and the run then exits 1 after the safe deletions, so
// the failure is seen. Every deletion and every skip is logged. Exit 0 done, 1 a deletion, a read or a PR state failed,
// 2 usage.
import { pathToFileURL } from 'node:url'
import { cloudflare } from './cloudflare.mjs'
import { listAll, loadApp, planTeardown, prsInListing, runTeardown } from './teardown.mjs'

export const APP_REPO = 'Useful-Build/inhouse'

/** 'open', 'closed' or 'unknown' for each PR, from the GitHub API. */
export async function prStates(prs, { token, fetchImpl = fetch }) {
  const out = new Map()
  for (const pr of prs) {
    const res = await fetchImpl(`https://api.github.com/repos/${APP_REPO}/pulls/${pr}`, {
      headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    })
    const state = res.ok ? (await res.json()).state : null
    out.set(pr, state === 'open' || state === 'closed' ? state : 'unknown')
  }
  return out
}

/** The cleanup's whole decision, from a listing and the PR states: which PRs go, which stay, and the deletions. */
export function planCleanup(listing, states, { app, zone }) {
  const prs = prsInListing(listing, app)
  const closed = prs.filter(pr => states.get(pr) === 'closed')
  const kept = prs.filter(pr => states.get(pr) !== 'closed').map(pr => ({ pr, state: states.get(pr) ?? 'unknown' }))
  return { closed, kept, ...planTeardown(listing, closed, { app, zone }) }
}

async function main(argv) {
  let dryRun = false
  let appDir
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run' && !dryRun) dryRun = true
    else if (argv[i] === '--app' && appDir === undefined && argv[i + 1]) appDir = argv[++i]
    else appDir = null
  }
  if (!appDir) {
    console.error('usage: node scripts/sandbox/cleanup.mjs --app <app main checkout>/app [--dry-run]')
    return 2
  }
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, CF_SANDBOX_ACCOUNT_ID: sandbox, SBX_ZONE: zone } = process.env
  if (!token || !accountId || accountId !== sandbox || !zone) {
    console.error('cleanup: needs CLOUDFLARE_API_TOKEN, SBX_ZONE, and CLOUDFLARE_ACCOUNT_ID equal to CF_SANDBOX_ACCOUNT_ID')
    return 2
  }
  const app = await loadApp(appDir)
  app.assertZone(zone)
  const cf = cloudflare({ token, accountId })
  const listing = await listAll(cf)
  const states = await prStates(prsInListing(listing, app), { token: process.env.GITHUB_TOKEN })
  const plan = planCleanup(listing, states, { app, zone })
  const log = line => console.log(`cleanup: ${line}`)
  log(`${dryRun ? 'DRY RUN. ' : ''}PRs with sandbox resources: closed ${JSON.stringify(plan.closed)}, kept ${JSON.stringify(plan.kept)}`)
  for (const s of plan.skipped) log(`skipped ${s.name}: ${s.why}`)
  if (plan.deletions.length === 0) log('nothing to delete')
  const failed = await runCleanupDeletions(cf, plan.deletions, { app, zone, dryRun, log })
  const result = cleanupResult(plan, failed)
  for (const line of result.lines) log(line)
  return result.code
}

/** The run's exit code and why: 1 when a PR's state couldn't be read or a PR's teardown failed, else 0. */
export function cleanupResult(plan, failed) {
  const lines = []
  const unknown = plan.kept.filter(k => k.state === 'unknown').map(k => k.pr)
  if (unknown.length > 0) lines.push(`failing: the state of PR(s) ${JSON.stringify(unknown)} couldn't be read, so their resources were kept`)
  if (failed.length > 0) lines.push(`failing: the teardown of PR(s) ${JSON.stringify(failed)} stopped part way (logged above); the other PRs were cleaned`)
  return { code: lines.length > 0 ? 1 : 0, lines }
}

/**
 * The deletions one PR at a time: a PR whose teardown fails (an unsafe key left in its bucket, say) is logged and
 * skipped, and the next PRs still go, so one stuck PR never blocks the daily sweep for the rest. Returns the failed
 * PRs. (deploy.mjs's own teardown of the PR it redeploys stays fail-fast.)
 */
export async function runCleanupDeletions(cf, deletions, { app, zone, dryRun, log }) {
  const failed = []
  for (const pr of [...new Set(deletions.map(d => d.pr))]) {
    try {
      await runTeardown(cf, deletions.filter(d => d.pr === pr), { app, zone, dryRun, log })
    } catch (err) {
      log(`PR ${pr}: teardown failed: ${err?.message ?? err}`)
      failed.push(pr)
    }
  }
  return failed
}

/** 1 when any PR's state couldn't be read (its resources were kept; the run fails so someone looks), else 0. */
export const cleanupExitCode = plan => (plan.kept.some(k => k.state === 'unknown') ? 1 : 0)

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, err => {
    console.error(`cleanup: failed: ${err?.message ?? err}`)
    process.exitCode = 1
  })
}
