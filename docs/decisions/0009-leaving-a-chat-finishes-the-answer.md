# 0009. Leaving a chat mid-answer finishes it in the background

- Status: accepted, 2026-11-17
- Was: UI plan 2 D9
- Plan: [UI plan 2, Decisions](../history/UI_PLAN_2.md#decisions) (PR 3)

## Context

Leaving a chat while it answered either had to let the answer finish or stop it with a note and Retry. The sidebar
already had a running dot.

## Decision

The answer finishes in the background. Several chats can answer at once, and Stop stops only the open chat's.

## Consequences

- The store keeps `runs` by chat id, and `updateChat` is the one writer of a chat's messages, open or not. Queued
  messages go out in the background too.
- A reload mid-answer says the answer stopped. Runs belong to the tab until a backend exists (production plan A-5).
