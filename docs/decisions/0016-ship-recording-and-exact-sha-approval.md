# 0016. Ship recording, and approval of the exact SHA

- Status: accepted, 2026-11-19; parts replaced by [0028](0028-merge-lanes-and-merge-queue.md) on 2026-11-27
- Was: setup plan, landing flow steps 4 to 7 (no id there)
- Plan: [setup plan, The landing flow](../plans/2026-11-19-setup-gaps.md#the-landing-flow-every-big-project)

## Context

Green checks don't show a person what changed. Approving a PR in chat also says nothing about which commit was
approved, and a later push could slip in.

## Decision

Before a final PR merges into `main`:

1. The QA agent drives the preview's fixed deployment URL against the project's browser scenarios and must PASS.
2. `ship.yml` (run by hand) records the project's ship specs against that same URL, desktop and phone, slowed for a
   person to follow, and stitches `reel.mp4` with a title card per scenario carrying the SHA.
3. The owner watches the reel and approves that head SHA in chat. A push after approval voids it.
4. It merges with `gh pr merge --squash --match-head-commit <sha>`, so GitHub refuses any other head.

## Consequences

- PR code runs only in the recording job, which has read access and no secrets. The stitch scripts come from `main`.
- The run fails on zero tests or a missing clip, so an empty reel can't pass.
- The first reel ran too fast to follow and was slowed 3 to 4 times (#31).
