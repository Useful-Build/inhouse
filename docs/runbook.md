# Incident and rollback runbook

Use this when the live site is broken or looks wrong. Read it top to bottom. Roll back first, find the cause later.

## What alerts exist

| Alert | Where it arrives | What it means |
|---|---|---|
| `Production check failing` issue, label `monitor`, assigned to the owner | GitHub issues, with the usual issue email | The hourly check (workflow `monitor`, `monitor.yml`) failed: the live page didn't answer 200, isn't the app's page, a deep link or its entry script didn't load. A `deploy` run that fails at or after the promote also opens or comments on this issue. |
| Failed `deploy` run | GitHub Actions, with the failed-run email | A push to `main` didn't fully ship (see "What a failed deploy leaves live"). |
| `client_error` lines | Workers Logs | Browsers reported a crash or an unhandled error (`POST /api/client-error`). Nobody is paged on these. Look at them in triage. |

The monitor comments on the open issue instead of opening a second one. A passing check comments and closes it.

### What a failed deploy leaves live

The `deploy` workflow (`deploy.yml`) uploads a new Worker version, smokes its Version URL, then promotes it to 100%.

- Failed before "Promote the version to 100%" (build, upload or the Version URL smoke): the old version is still live.
- The promote retries only Cloudflare's "version not found" (code 100146) answer, which the API can give for a few
  seconds after an upload: after 3, 6, 9 and 12 s. A promote that failed with 100146 on every try left the old version
  live; re-run the job.
- Failed at or after the promote (custom domain, active-deployment check or live smoke): the new version may be live.
  Check `npx wrangler deployments list --name inhouse-app` (in `app/`) before you decide.
- The release is created last, only after every step passed. A failed run has no release. A red run whose `deploy`
  job is green failed only at the release: the new version is live, and no issue opens.

## Triage in the first 10 minutes

1. **Is it real?** Open the live site in a private window. Hard reload.
2. **Check the monitor issue.** Open issues with the `monitor` label. Note the time of the first failure and what failed
   (page, entry script or deep link).
3. **Check the last deploy.** In Actions, open the latest `deploy` run on `main`. Note its commit, its result and when
   it finished. Open the matching release (`vYYYY.MM.DD.N`), which names the Worker version id.
4. **Line up the times.** A failure that starts right after a deploy points at that deploy. A failure with no deploy
   nearby points at Cloudflare or the network. Check the Cloudflare status page.
5. **Read Workers Logs.** Filter for `event` = `client_error`. Each line carries `kind` (`error`, `rejection`,
   `boundary`, `route` or `unknown`), `message`, `stack`, `url`, `release` and `country`. Reports from the `?demo&crash=`
   switches carry `demo: true`: leave those out. The flag is sent by the browser, so anyone posting a
   report can set it; it's a filter for convenience, not proof. Look for one message repeated many times,
   and the first time it appeared. Errors only from old tabs after a deploy are usually a stale lazy route, not an outage.
6. **Decide.** If a deploy caused it, or you can't tell, roll back (next section). Don't debug on the live site.

## Roll back

Rollback moves the live site to an earlier Worker version. It takes seconds and needs no build.

1. **Find the last good version id.** Pick one of:
   - The release notes of the last good release: they say "Deployed to production as Worker version `<id>`".
   - `npx wrangler deployments list --name inhouse-app`, run in `app/`. It shows only the 10 most recent
     deployments, each with its version id and time. Take the one before the bad deploy. For an older one, use the
     release notes.
2. **Run the rollback.** Pick one of:
   - Actions, then `deploy`, then Run workflow on `main`, with `rollback_to` set to the version id (a UUID).
   - `gh workflow run deploy -f rollback_to=<version-id>`
3. With `rollback_to` set, the `deploy` workflow skips the build, runs `wrangler rollback`, checks the active
   deployment is that version at 100% and smokes the live site. A rollback and a deploy share one concurrency
   group (`production`), so they queue and never run at the same time. It makes no release. A push that lands
   while a rollback waits cancels the waiting rollback (its run shows cancelled): run it again after that deploy.
   A rollback run can't be re-run; dispatch a new one.

If the workflow itself is broken, run this by hand in `app/`, with the Cloudflare login:
`npx wrangler rollback <version-id> --name inhouse-app -y -m "<reason>"`

### What rollback can't undo

- **Backend data.** Rollback swaps the Worker version (code, config and static assets), not stored data. Any data a future backend has written stays as it is. Before you roll
  back past a change that altered stored data, check that the older code can still read it.
- **Bindings and migrations.** Cloudflare may refuse a rollback across a change to bindings or migrations (see
  [Cloudflare's rollback docs](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)). If it
  does, fix forward.
- **Pushes to `main`.** The next push deploys again. If the bad commit is still on `main`, revert it before anything
  else merges.

## Confirm recovery

- The rollback run's "Smoke the live hostname" step passes.
- Open the live site and click through Today and one other route.
- Run the monitor by hand (`gh workflow run monitor`) and see it pass. A passing run closes the `monitor` issue.
- Watch Workers Logs for a few minutes. `client_error` lines should drop to their usual rate.
- Comment on the `monitor` issue with the version id you rolled back to and the time. Do it before the monitor passes,
  or the issue closes first and you comment on a closed one.

## Follow-up

Within a day, open an issue that holds:

- The timeline: first bad deploy, first alert, rollback, recovery (times and run links).
- The cause, in a sentence or two.
- The test or check that would have caught it before it shipped. Write that test, or file it as its own issue.

Then revert or fix the bad commit on a branch and let the normal change loop ship it.

## Rotate `HUB_TOKEN_KEYS` (connector hub)

Rotate the connector hub's token encryption keys without downtime:

1. Add the new key to `keys` in `HUB_TOKEN_KEYS`, keeping `current` unchanged. Set it with `wrangler secret put HUB_TOKEN_KEYS` (through a secret card; this deploys a new version).
2. Update `current` to the new `kid` and put again. New envelopes seal under the new key while old envelopes still decrypt.
3. Wait for scheduled refreshes to re-seal existing records (Shopify refreshes about every 12 h; reads also re-seal lazily), or call `ServerGateway.reencrypt(scope, accountId)` per account.
4. Once `ServerGateway.status` shows the new `kid` for every account, remove the old key from `keys` and put again.

Removing a key still in use marks that record `key_unavailable`: a client-credentials account discards it and re-grants (`signin_key_missing`); an OAuth account requires a reconnect.
