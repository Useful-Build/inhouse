# 0018. A custom domain, and the demo is indexable

- Status: accepted, 2026-11-19. Built in the hardening project (`fleet/hardening`)
- Was: production plan PD2, PD3
- Plan: [production plan, Decisions](../plans/2026-11-19-production.md#decisions)

## Context

The demo ran only on a workers.dev URL and sent `noindex`. As a public case study it needs a stable address people
can find.

## Decision

Serve the demo on a custom subdomain of the organisation's Cloudflare zone. It's the only deployment until the backend
adds a product one. The demo is indexable. Previews keep `noindex` (0012).

## Consequences

HSTS on the custom domain, and the repo's homepage points to it. `deploy.yml` attaches the domain to the
Worker through the Workers Domains API on every deploy and rollback, so it can't drift from the code.
