# 0004. Team settings are read-only on a phone

- Status: accepted, 2026-11-17
- Was: UI plan 2 D4
- Plan: [UI plan 2, Decisions](../history/UI_PLAN_2.md#decisions) (PR 7)

## Context

Admins could change team settings (effort pickers, exports) from a phone, where the controls cramped and a slip
changes the whole team.

## Decision

On a phone, team settings pages show their values as text with a one-line note. The controls stay on desktop. Your own
settings keep theirs, and action rows (Pause, Invite, Export, Download CSV) still work.

## Consequences

The phone visual baselines show team settings as text (`e2e/states.ts` notes it).
