# 0008. What the agent says to an off-script question

- Status: accepted, 2026-11-17
- Was: UI plan 2 D8
- Plan: [UI plan 2, Decisions](../history/UI_PLAN_2.md#decisions) (PR 3)

## Context

The mock answers from a script. A question outside it needed an answer that doesn't break the demo's story.

## Decision

The answer says it can't answer that from your tools yet, names the six tools and offers the suggested questions as
chips that ask them. It never says "sample data".

## Consequences

A `suggestions` part in the answer (`app/src/screens/chat/Parts.tsx`, the chip in `app/src/ui/chat.tsx`).
