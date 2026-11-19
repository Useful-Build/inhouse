# Incident and rollback runbook

Use this when the live site is broken or looks wrong. Read it top to bottom. Roll back first, find the cause later.

## What alerts exist

| Alert | Where it arrives | What it means |
|---|---|---|
| `Production check failing` issue, label `monitor` | GitHub issues, with the usual issue email | The hourly check of the live site failed (`monitor.yml`). |
| Failed `deploy` run | GitHub Actions, with the failed-run email | A push to `main` did not reach the live site, or the smoke after it failed. |
| `client-error` lines | Workers Logs | Browsers reported a crash or an unhandled error (`/api/client-error`). Nobody is paged on these. Look at them in triage. |

The monitor opens one issue and keeps adding to it. It does not open a second one while the first is open.

## Triage in the first 10 minutes

1. **Is it real?** Open the live site in a private window. Hard reload.
2. **Check the monitor issue.** Open issues with the `monitor` label. Note the time of the first failure and what failed
   (page, asset or smoke spec).
3. **Check the last deploy.** In Actions, open the latest `deploy` run on `main`. Note its commit, its result and when
   it finished. Open the matching release (`vYYYY.MM.DD.N`).
4. **Line up the times.** A failure that starts right after a deploy points at that deploy. A failure with no deploy
   nearby points at Cloudflare or the network. Check the Cloudflare status page.
5. **Read Workers Logs.** Filter for `client-error`. Look for one message repeated many times, and the first time it
   appeared. Errors only from old tabs after a deploy are usually a stale lazy route, not an outage.
6. **Decide.** If a deploy caused it, or you can't tell, roll back (next section). Don't debug on the live site.

## Roll back

Rollback moves the live site to an earlier Worker version. It takes seconds and needs no build.

1. **Find the last good version id.** Pick one of:
   - `npx wrangler deployments list`, run in `app/`. Each deployment shows its version id and time. Take the one
     before the bad deploy.
   - The release notes of the last good release, which name the version id.
2. **Run the rollback.** Pick one of:
   - Actions, then `deploy`, then Run workflow, with `rollback_to` set to the version id.
   - `gh workflow run deploy -f rollback_to=<version-id>`
3. The workflow runs `wrangler rollback` and then smokes the live site. A rollback and a deploy share one concurrency
   group, so they never run at the same time.

If the workflow itself is broken, run `npx wrangler rollback <version-id>` by hand in `app/`, with the Cloudflare login.

### What rollback can't undo

- **Backend data.** Rollback swaps code only. Any data a future backend has written stays as it is. Before you roll
  back past a change that altered stored data, check that the older code can still read it.
- **Bindings and settings.** Cloudflare won't roll back across a change to bindings or migrations. If that's the
  cause, fix forward.
- **Pushes to `main`.** The next push deploys again. If the bad commit is still on `main`, revert it before anything
  else merges.

## Confirm recovery

- The deploy run's smoke step passes against the live site.
- Open the live site and click through Today and one other route.
- Run the monitor by hand (Actions, `monitor`, Run workflow) and see it pass.
- Watch Workers Logs for a few minutes. The `client-error` rate should drop to its usual level.
- Comment on the `monitor` issue with the version id you rolled back to and the time. Close it once the monitor has
  passed again.

## Follow-up

Within a day, open an issue that holds:

- The timeline: first bad deploy, first alert, rollback, recovery (times and run links).
- The cause, in a sentence or two.
- The test or check that would have caught it before it shipped. Write that test, or file it as its own issue.

Then revert or fix the bad commit on a branch and let the normal change loop ship it.
