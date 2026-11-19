# 0003. Phone answer actions: Copy, steps and a menu

- Status: accepted, 2026-11-17
- Was: UI plan 2 D3
- Plan: [UI plan 2, Decisions](../history/UI_PLAN_2.md#decisions) (PR 5)

## Context

The first UI plan shipped six icons under every answer on a phone. At 390px they crowded the row and were hard to hit.

## Decision

On a phone the row under an answer is Copy, the steps link and a "···" menu that holds the rest (thumbs as radio
items).

## Consequences

Desktop keeps its hover actions. `e2e/conversation-polish.spec.ts` checks the phone row.
