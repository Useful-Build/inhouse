# 0007. Phase 1 memory in local storage

- Status: accepted, 2026-11-17
- Was: UI plan 2 D7
- Plan: [UI plan 2, Decisions](../history/UI_PLAN_2.md#decisions) (PR 3)

## Context

With no backend, a reload lost started chats, drafts and picks. Copy link on a new chat was broken without them.

## Decision

Keep the chats a person started, what they added to any chat, composer drafts, the model pick, thumbs and the Library
view in local storage until Reset demo.

## Consequences

- Saved under `inhouse.ui.session.v1` and sanitized on load (property tests in `src/**/*.property.test.ts`). The
  mock agent keeps its own keys. Reset demo clears them all.
- The browser owns chat history for now. The production plan records this as contract finding A-2, for the backend.
