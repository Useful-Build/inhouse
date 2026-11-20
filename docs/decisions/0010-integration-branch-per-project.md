# 0010. One integration branch per big project

- Status: accepted, 2026-11-19
- Was: setup plan D1
- Plan: [setup plan, Decisions](../plans/2026-11-19-setup-gaps.md#decisions), [setup plan, The landing flow](../plans/2026-11-19-setup-gaps.md#the-landing-flow-every-big-project)

## Context

Big projects arrive as several worker PRs built in parallel. Merging each into `main` on its own put half-finished
work and throwaway commits there, and left no single point to review and ship the whole.

## Decision

Each big project gets one branch, `fleet/<topic>`, cut from `main`. Every worker PR goes into it with a merge commit.
`main` comes in through a PR too. One final PR takes the branch into `main` through the ship gate (0016).

## Consequences

- The name only marks an integration branch. Inhouse is not a fleet repo: a stale design with a merge queue and
  code-owner review lost to 0013, and adopting it later is its own decision.
- Workflow changes that `workflow_run` or `workflow_dispatch` must see go straight to `main` first as bootstrap
  PRs, since those triggers only read the default branch's files.
