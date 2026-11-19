# How this repo is built

Inhouse is built by AI coding agents. A person sets the goal, approves plans and decisions, and watches a recording
before anything big ships. Agents write the plans, the code, the tests and the reviews. This page explains how that
works here, and what went wrong along the way.

The pieces live in the repo, so you can check each claim against the files and the PR history.

## What the agents read first

- **[AGENTS.md](../AGENTS.md)** is the rules file every agent loads: layout, commands, what "done" means, which paths
  are sensitive and how changes land.
- **The verify skill** ([.agents/skills/verify/SKILL.md](../.agents/skills/verify/SKILL.md)) says how to boot, seed,
  drive and test the app: ports, demo switches, storage keys, every suite and how to run it.
- **The feature map** ([feature-map.md](../.agents/skills/verify/feature-map.md)) lists what each screen does, as a
  path, a selector and an expected result, with a `Covered:` line naming the specs that check it. Its Gaps section
  says plainly what no spec checks. An agent changing a screen finds its entry, and a user-facing change updates it.
- **Plans** in [docs/plans/](plans/) are approved before work starts. Each one has its decisions, a work plan split by
  file ownership, an acceptance checklist and a must-not list. Plans get second opinions from two model families
  (Claude Fable and GPT) before the owner approves them.

## The change loop

1. **An orchestrator agent plans the work** and splits it into pieces that don't share files.
2. **Workers build in their own git worktrees**, one branch and one PR each, in parallel. A worker gets a brief with
   the files it owns, the change and how to check it. Sonnet takes scoped jobs, Opus the sensitive ones (CI security,
   state and run lifecycle).
3. **Each commit says how it was verified.** The last paragraph of the commit message holds only trailers, and one of
   them is `Verified:`, for example `Verified: navigation.spec.ts 8/8 locally; tsc, lint`. The `pr-gates` check fails a
   commit without it.
4. **CI runs everything.** Type check, lint, property tests, build and every Playwright project, on every PR. A PR that
   changes an existing check (a spec, a baseline, a lint rule, a workflow) is flagged, and its description has to say
   why. A check is never loosened to make a change pass.
5. **Reviews.** Every PR gets a Sonnet review and an Opus review, split by area, for one to three rounds. Findings are
   fixed in the same PR. A finding that's dismissed is written down with the reason.
6. **Merge.** When CI and reviews are clean, the PR merges.

## The integration branch and the ship gate

A big project runs on one branch, `fleet/<topic>`, cut from `main`
([0010](decisions/0010-integration-branch-per-project.md)). Worker PRs merge into it with merge commits. Rulesets make
it real: no direct pushes, a PR and both checks required, no bypass even for the admin account the agents act as
([0013](decisions/0013-rulesets-as-committed-json.md)).

The final PR from `fleet/<topic>` into `main` goes through the ship gate
([0016](decisions/0016-ship-recording-and-exact-sha-approval.md)):

1. Full CI on a branch that's up to date with `main`, and a final Sonnet and Opus review of the whole branch.
2. A preview of that exact commit ([0011](decisions/0011-workers-previews-from-trusted-workflow.md)).
3. A QA agent drives the preview through the project's browser scenarios, one screenshot each, and must return PASS.
4. `ship.yml` records the same scenarios on desktop and phone into one `reel.mp4`, with the SHA on every title card.
5. The owner watches the reel and approves that SHA in chat. A push after approval voids it.
6. The PR squash-merges with `--match-head-commit <sha>`, so GitHub refuses any other head. The squash message ends in
   a `Verified:` trailer.

The setup project ([plan](plans/2026-11-19-setup-gaps.md), PR #30) was the first to land this way.

## What we learned

Each of these is in the PR history.

- **Reviews found two ways a PR could reach the preview token.** The preview pipeline (#19) deploys a build that a PR
  controls, from a job that holds a Cloudflare token. Review rounds on the first version caught two holes. A PR could change the wrangler config inside its own build, or leave files
  that wrangler reads at deploy time (a `.env` can point it at another API host). And a source map comment in a built
  file could make wrangler read a file outside the build and upload it. The fix treats the build as hostile: only
  plain files under `dist/` pass, the generated config must match `main`'s field by field, wrangler runs with no
  `.env` and no endpoint overrides, and every source map must be a plain sibling file. The tests behind it ran more
  than a hundred good and bad samples.
- **Removing a fixed wait made a test race.** #17 replaced a one-second sleep in the sidebar tooltip test with the
  page clock. The second half of the test then failed every time locally and once in CI: tooltip state from the first
  hover carried over. #20 waits for Radix's own tooltip open event instead and runs the second check on a fresh page.
  The lint rule against fixed waits stayed.
- **A squash message broke the trailer check for later PRs.** The squash messages of #18 and #19 put an "Approved
  by" line inside the trailer block, so git no longer parsed `Verified:` as a trailer. When `main` was brought into
  the integration branch (#22), `pr-gates` saw those commits again and failed, and history can't be rewritten. #23
  made `pr-gates` skip commits already on `main`, and the rule now says the last paragraph holds only trailers.
- **One-shot layout checks flake after a resize.** A phone check read the page width once, right after a viewport
  change, before the layout settled. It failed once in CI. #24 made every such check poll until the layout settles,
  with the same assertion.
- **A reel that's right can still be too fast.** The first ship reel was correct but too quick to follow. #31 slowed
  it 3 to 4 times. #27 fixed title cards that drew wrapped lines on top of each other. A recording is for a person, so
  a person's review of it is part of the check.
- **Write the rule into a check.** Advice in `AGENTS.md` didn't stop throwaway commits reaching `main`. Rulesets did.
  The same for fixed waits: #9 removed them once, and they came back until #17 added a lint rule.

## Where to look

- [Architecture](architecture.md): the app, the Worker, CI, previews and deploys.
- [Decision records](decisions/README.md): why each piece is the way it is.
- [Runbook](runbook.md): what to do when production breaks.
- [docs/history/](history/): finished trackers, kept as they were.
