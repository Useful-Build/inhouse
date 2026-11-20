# 0001. Base variants: upstream what any app needs, wrap the rest

- Status: accepted, 2026-11-17
- Was: UI plan 2 D1
- Plan: [UI plan 2, Decisions](../history/UI_PLAN_2.md#decisions) (PR 1)

## Context

Inhouse had extra `Button`, `Badge`, `Input` and `Sheet` variants on top of ui-base, the shared shadcn registry.
Every ui-base update rewrites `src/components/ui/`, so app edits there get lost.

## Decision

Upstream the variants any app needs (`xs`, `icon-round`, `aria-pressed`, Badge `size`, Input `sm`, Sheet
`overlayProps`) as a ui-base release. Keep the Inhouse-only looks (`chrome`, `surface`, `inverse`, `quiet`) in
`src/ui` wrappers.

## Consequences

- ui-base v1.1.0 shipped the upstream half. The app pulls it with the shadcn CLI.
- `src/components/ui/` and `src/ui-base.css` are never edited by hand (except `icon.tsx`). An app look goes in a
  `src/ui` wrapper. `lint:tokens` and `app/DESIGN_APP.md` hold the line.
