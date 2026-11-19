# 0017. Harden the demo first, plan the backend separately

- Status: accepted, 2026-11-19
- Was: production plan PD1
- Plan: [production plan, Decisions](../plans/2026-11-19-production.md#decisions)

## Context

The production audits found gaps in the demo (headers, deploys, monitoring, docs) and in the agent contract. Fixing both
at once would mix a hardening project with a backend design.

## Decision

The production plan is the hardening project only. The agent contract and the real backend are a separate plan with
their own platform choices. The contract findings (A-1 to A-10) are recorded for it, not acted on.

## Consequences

The backend plan (`docs/plans/2026-11-19-backend.md`) came next. Its decisions use the prefix `BD` and become
records here as its phases land.
