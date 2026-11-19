# 0021. Monitoring: a scheduled check, Web Analytics and a runbook

- Status: accepted, 2026-11-19. Being built in the hardening project (`fleet/hardening`)
- Was: production plan PD7
- Plan: [production plan, Decisions](../plans/2026-11-19-production.md#decisions)

## Context

No uptime check, no alerting, no Core Web Vitals and no written steps for an incident or a rollback.

## Decision

- A scheduled workflow checks production (the page, an asset and one small read-only spec) and notifies the owner on
  failure, with a keepalive so GitHub doesn't turn the schedule off after 60 idle days.
- Core Web Vitals from Cloudflare Web Analytics (page loads; hash routes aren't told apart).
- A CI budget on the initial JS bundle.
- A short incident and rollback runbook, [docs/runbook.md](../runbook.md).

## Consequences

Free tools that fit one small demo. A product deployment will need more (the backend plan).
