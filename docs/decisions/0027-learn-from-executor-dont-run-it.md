# 0027. Learn from Executor's sign-in code, don't run it

- Status: accepted, 2026-11-26 (Wasim approved the connect-any-tool plan and its W1 to W4)
- Plan: [Connecting any tool](../plans/2026-11-26-connect-any-tool.md), folded into the
  [master plan](../plans/2026-11-24-master-plan.md) (D6, M4)
- Extends: [P0 S4, "Why not self-hosted Executor"](p0-s4-connector-hub.md#why-not-self-hosted-executor)

## Context

M4 lets the Inhouse team connect any tool for a brand: by sign-in, by API key, or through a small connector we build.
Executor (MIT) is an open-source tool hub that has met many real services that break the sign-in standard in small
ways (a missing token type, errors sent with a success status, a shared issuer). Our hub's generic sign-in path only
serves Slack today, and reading Executor's code turned up four flaws in it that M4 would hit.

## Decision

We keep our own hub and don't run Executor in the product (P0 S4 still holds). We read its code at a pinned commit and
take its knowledge: the sign-in exceptions of real services, the "is this login really dead?" renewal rules, sign-in
type detection from an address, plain failure reasons, its test scenarios and per-server defaults. Each rule is
written and tested in our own code, with a fixture test per exception. Where a module carries over their logic, its
header keeps Executor's MIT notice.

## Consequences

- M4 fixes the four sign-in flaws in `app/hub/oauth/` and `app/hub/signin/core.ts` and adds the exceptions as tests.
- `docs/adopted-libraries.md` lists Executor as "learned from", with the pinned commit; each milestone that touches
  sign-in re-scans its exceptions for new ones.
- No new runtime dependency, and no Effect framework in our code.
