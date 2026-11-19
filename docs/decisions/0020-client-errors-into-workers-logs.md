# 0020. Client errors go to Workers Logs

- Status: accepted, 2026-11-19. Being built in the hardening project (`fleet/hardening`)
- Was: production plan PD6
- Plan: [production plan, Decisions](../plans/2026-11-19-production.md#decisions)

## Context

Errors in a visitor's browser went nowhere, and the crash screen's "Message the team" had no destination.

## Decision

The browser reports errors to `/api/client-error` on the app's own Worker (`run_worker_first` for `/api/*`). The
route rate-limits, scrubs and size-caps the payload and logs it to Workers Logs with the release SHA. Hidden source maps
are kept per SHA as a CI artifact and never served.

## Consequences

- No third-party error service and no extra cost at this volume. Recheck Workers Logs pricing after its 1 December
  2026 change.
- `/api/*` is the one path that reaches the Worker before static assets, which is also where a backend would start.
