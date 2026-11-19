# 0005. US formats and one demo clock

- Status: accepted, 2026-11-17
- Was: UI plan 2 D5
- Plan: [UI plan 2, Decisions](../history/UI_PLAN_2.md#decisions) (PR 3)

## Context

The demo mixed formats and called 17 Nov 2026 a Monday (it's a Tuesday). Screens took times from different places, so
facts disagreed across pages.

## Decision

US formats and 12-hour time. One fixed demo clock: Monday, November 16, 2026 from 8:00 AM, device-local, moving with
real time from the first load. Everything a person does is stamped on it.

## Consequences

- `app/src/agent/clock.ts` is the one clock. Shown times keep a no-break space before AM or PM, and lists sort on
  stored values, never on a shown string.
- `e2e/sample-data.spec.ts` checks that weekdays, times, counts and amounts agree across screens.
