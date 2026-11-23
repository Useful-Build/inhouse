# How this repo is built

Inhouse is built by AI coding agents. A person sets the goal, approves plans and decisions, and watches a recording
before anything big ships. Agents write the plans, the code, the tests and the reviews. This page explains how that
works here, and what went wrong along the way.

The pieces live in the repo, so you can check each claim against the files and the PR history.

## What the agents read first

The repo keeps 5 core markdown files in the root so any model or cloud runner loads what it needs without external skill plumbing:

- **[AGENTS.md](../AGENTS.md)** is always loaded: layout, commands, workflow, and repo invariants.
- **[REVIEW.md](../REVIEW.md)** holds the risk tiers, sensitive paths, severity rules, and fresh-context PR review workflow (always read from `main`).
- **[VERIFY.md](../VERIFY.md)** says how to boot, seed, drive, test, and run targeted live QA on the app.
- **[DESIGN.md](../DESIGN.md)** defines the design bar, `ui-base` ownership, hard token rules, dark mode, and UI copy voice.
- **[FEATURE_MAP.md](../FEATURE_MAP.md)** lists what each screen does, as a path, selector, expected result, and `Covered:` specs, with a `Gaps` section at the top. An agent changing a screen reads its entry and updates it in the same PR.
- **Plans** in [docs/plans/](plans/) are approved before big multi-phase work starts. Each one has decisions, ownership, and an acceptance checklist.

## The change loop

1. **One strong agent owns the task end to end** on a feature branch (splitting into parallel subagents only when work cleanly separates by files).
2. **Each commit says how it was verified.** The last paragraph of the commit message holds only trailers, and one of
   them is `Verified:`, for example `Verified: tsc, lint, unit locally; e2e and visual in CI`. The `pr-gates` check fails a
   commit without it.
3. **CI runs everything.** Type check, lint, property tests, build and every Playwright project, on every PR into `main`. A PR that
   changes an existing check (a spec, a baseline, a lint rule, a workflow) is flagged, and its description has to say
   why. A check is never loosened to make a change pass.
4. **Targeted live QA and risk-tiered reviews.** Every user-facing or agent-behavior PR gets targeted live QA on the PR before merge (`VERIFY.md`). Reviews scale to risk (`REVIEW.md`, always read from `main`): Low-risk PRs need CI + self-check only; Normal PRs get 1 fresh-context Opus 5.5 (high) review; Sensitive PRs get Fable 5.2 (high) + Gemini 4 Neon (high) + Wasim's OK.
5. **Merge and deploy.** When CI and reviews are clean, the PR squash-merges into `main` and `deploy.yml` ships it.

## Integration branches and milestone releases

Big multi-PR milestones use an integration branch, `fleet/<topic>`, cut from `main`
([0010](decisions/0010-integration-branch-per-project.md)). Feature PRs merge into it with merge commits. Rulesets make
it real: no direct pushes, a PR and both checks required, no bypass even for the admin account
([0013](decisions/0013-rulesets-as-committed-json.md)).

The final PR from `fleet/<topic>` into `main` goes through the ship gate
([0016](decisions/0016-ship-recording-and-exact-sha-approval.md)):

1. Full CI on a branch that's up to date with `main`, and a final risk-tiered review of the whole branch (`REVIEW.md`).
2. Targeted live QA on the preview or sandbox build for that exact commit ([0011](decisions/0011-workers-previews-from-trusted-workflow.md)).
3. `ship.yml` records the milestone's browser scenarios on desktop and phone into one `reel.mp4`, with the SHA on every title card.
4. The owner watches the reel and approves that SHA in chat. A push after approval voids it.
5. The PR squash-merges with `--match-head-commit <sha>`, so GitHub refuses any other head. The squash message ends in
   a `Verified:` trailer.

The setup project ([plan](plans/2026-11-19-setup-gaps.md), PR #30) was the first to land this way.

## What we learned

Each of these is in the PR history.

- **Reviews found two ways a PR could reach the preview token.** The preview pipeline (#19) deploys a build that a PR
  controls, from a job that holds a Cloudflare token. Review rounds on the first version caught two holes. A PR could
  change the wrangler config inside its own build, or leave files that wrangler reads at deploy time (a `.env` can point it at another API host). And a source map comment in a built
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
