# 0014. Global skills follow once the flow has shipped

- Status: accepted, 2026-11-19
- Was: setup plan D5
- Plan: [setup plan, Decisions](../plans/2026-11-19-setup-gaps.md#decisions)

## Context

The landing flow (integration branch, previews, ship recording) was new. The global agent skills (`change-loop`,
`verification`, `repo-setup`, `fleet`, `qa-check`) teach every repo how to work.

## Decision

Update the global skills only after the flow has shipped once here, as an opt-in flow distinct from fleet policy.

## Consequences

This repo is the reference. What's written into the global skills has run end to end at least once.
