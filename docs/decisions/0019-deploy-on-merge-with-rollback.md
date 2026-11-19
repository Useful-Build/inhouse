# 0019. Deploy on merge, with rollback by version id

- Status: accepted, 2026-11-19. Built in the hardening project (`fleet/hardening`)
- Was: production plan PD4
- Plan: [production plan, Decisions](../plans/2026-11-19-production.md#decisions)

## Context

Production deployed by hand from a laptop. Nothing linked a deploy to its commit, and there were no releases.

## Decision

`deploy.yml` deploys each merge to `main`:

1. A build job with no secrets uploads the exact build.
2. A trusted job in environment `production` runs `wrangler versions upload --tag <sha>`, smokes that Version URL,
   promotes it with `wrangler versions deploy <id>@100%`, then smokes the live hostname.
3. It tags a GitHub release `vYYYY.MM.DD.N`.

Deploy and rollback share one concurrency group. Rollback goes to an explicit version id and was rehearsed once. No
staging environment and no percentage rollout.

## Consequences

- No production deploy from a laptop once `deploy.yml` lands.
- A rollback restores assets with the version. An old tab can still ask for a lazy chunk that's gone, so the app
  reloads once on a preload error and keeps drafts.
