# 0013. Branch rulesets as committed JSON, with no bypass

- Status: accepted, 2026-11-19
- Was: setup plan D4
- Plan: [setup plan, Decisions](../plans/2026-11-19-setup-gaps.md#decisions)

## Context

`main` had no protection. The merge rules in `AGENTS.md` were advice, and throwaway commits reached `main`.

## Decision

Two rulesets, kept as JSON in `.github/rulesets/` and applied with `gh api`:

- `main`: PR required, checks `ci` and `pr-gates`, branch up to date, squash only, no force push or deletion.
- `fleet/**`: PR and both checks required, not strict, merge commits only, no force push, a new branch can be
  created, a merged one deleted.
- No bypass actors on either: agents act as the admin, so a bypass would void the gate.
- No required approvals (GitHub won't let the owner approve PRs that agents open under the owner's own account; approval happens in chat) and
  no merge queue for now (CI takes about 11 minutes).

## Consequences

- A ruleset change is a reviewed file change, then one `gh api -X PUT`.
- The human approval lives outside GitHub's review model. 0016 pins it to an exact SHA instead.
