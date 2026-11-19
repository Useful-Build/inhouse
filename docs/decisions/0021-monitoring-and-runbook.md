# 0021. Monitoring: a scheduled check, a runbook and (not built yet) Web Analytics

- Status: accepted, 2026-11-19. Built in the hardening project (`fleet/hardening`)
- Was: production plan PD7
- Plan: [production plan, Decisions](../plans/2026-11-19-production.md#decisions)

## Context

No uptime check, no alerting, no Core Web Vitals and no written steps for an incident or a rollback.

## Decision

- A scheduled workflow (`monitor.yml`, hourly) checks production with curl: the page, its entry script and a deep
  link. On a failure it opens or comments on a `Production check failing` issue assigned to the owner.
- Built differently from the plan: the small read-only browser spec was dropped (curl covers the same paths for less),
  and there's no keepalive. GitHub only resets its 60-day timer on repository activity, so a workflow can't keep
  itself alive without committing. Dependabot's weekly PRs and merges keep the repo active; if it ever goes quiet,
  re-enable the workflow (`gh workflow enable monitor`).
- Core Web Vitals from Cloudflare Web Analytics (page loads; hash routes aren't told apart). Not built yet: the beacon
  needs a Web Analytics site created in the Cloudflare account first. Until then the CSP allows no analytics hosts;
  adding the beacon means adding `https://static.cloudflareinsights.com` to `script-src` and
  `https://cloudflareinsights.com` to `connect-src`.
- A CI budget on the initial JS bundle.
- A short incident and rollback runbook, [docs/runbook.md](../runbook.md).

## Consequences

Free tools that fit one small demo. A product deployment will need more (the backend plan).
