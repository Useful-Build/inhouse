# 0022. Subset the icon font

- Status: accepted, 2026-11-19. Built in the hardening project (`fleet/hardening`)
- Was: production plan PD8
- Plan: [production plan, Decisions](../plans/2026-11-19-production.md#decisions)

## Context

The Material Symbols font was 3.1 MB and preloaded. Icons stayed invisible until it loaded. About 92 names are used in
code, and more come from data.

## Decision

Subset the font with Google's `icon_names` parameter, keeping the axes in use. Keep `font-display: block`, since
swap would flash the ligature text. Generate a manifest of names from source and sample data, check it in CI, and show
a fallback glyph at the data boundary for unknown names. The typed union lives in `src/ui/` (`icon-names.ts` is
base-owned).

## Consequences

A new icon name means regenerating the subset, or CI fails. The visual suite must pass with no baseline update.
