# 0002. One card per answer

- Status: accepted after mockups, 2026-11-17
- Was: UI plan 2 D2
- Plan: [UI plan 2, Decisions](../history/UI_PLAN_2.md#decisions) (PR 5)

## Context

An answer drew one white bubble per part (text, table, draft), and text could sit straight on the dotted background.
The page read as fragments, not one reply.

## Decision

One white card per answer turn, with its text, tables, drafts and routines inside. The person's message is a soft grey
bubble. Text never sits on the dots.

## Consequences

- It changed the v4 look, so it was a design call, approved after mockups.
- The card has one measure (about 72 characters) and one right edge. Drafts and routines are inset blocks, tables sit
  between hairlines. A streaming answer's thinking line lives in the same card, so no second card appears.
- Code: `app/src/screens/chat/Parts.tsx`. Every chat baseline changed with it.
