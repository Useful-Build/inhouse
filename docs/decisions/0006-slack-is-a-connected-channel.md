# 0006. Slack is connected in the demo, as a channel

- Status: accepted, 2026-11-17
- Was: UI plan 2 D6
- Plan: [UI plan 2, Decisions](../history/UI_PLAN_2.md#decisions) (PR 3)

## Context

The demo either had to show Slack connected or remove every mention of it. Act and Run post to Slack.

## Decision

Slack is connected, as a channel from Act (`tools.channels`), not a tool the agent reads. In Watch it shows as
included from Act.

## Consequences

`toolView` and `toolCounts` in `app/src/state/derive.ts` give one answer for Tools, a tool page and the composer.
Copy says "Chats" or "Chats and Slack" by stage.
