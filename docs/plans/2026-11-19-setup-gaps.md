# Setup gaps: plan and spec

Status: final draft, 2026-11-19. Decisions approved by Wasim; revised after second opinions from Claude Fable 5.2
(xhigh) and GPT 6.2 Sol via Pi (xhigh). Implementation starts once the production plan is also on the table.

## Goal

Make Inhouse's agent layer and change flow correct and enforced, so the repo is the reference example for other
projects, and add a ship gate: every big project lands through one integration branch, a preview URL, a QA pass and
a screen recording Wasim watches before it merges and ships.

## Audit findings (2026-11-19)

Right today: lean AGENTS.md with "How changes land here"; `verify` skill symlinked and loaded; approved feature map
with `Covered:` lines; ~60 Playwright specs (desktop, phone, visual, a11y, motion); Linux baselines in a
digest-pinned Playwright image; sharded CI with a fail-closed `ci` job; SHA-pinned actions; `pr-gates`; fast-check
property tests in CI; token lint scripts; typecheck, lint and unit green; Node 26 in `.nvmrc` and CI.

Gaps:
1. `main` has no branch protection or ruleset; merge rules in AGENTS.md aren't enforced; throwaway commits reached
   `main`.
2. Feature map claims no gaps but has no entry for Settings pages Notifications, Memory, Inhouse agent, Spending cap,
   Data and access, Audit log, nor the Help and guides window; `pages-polish.spec.ts` and `phone.spec.ts` are
   unreferenced.
3. Fixed waits remain: `navigation.spec.ts` `waitForTimeout(1000)`, a `setTimeout` tick in `cross-screen.spec.ts`.
   Nothing stops new ones (PR #9 removed them once already).
4. `pr-gates` check paths miss `app/src/**/*.property.test.ts`.
5. AGENTS.md: Commands miss `test:unit`, `preview`, `deploy`; "Done means" omits unit tests; sensitive paths miss
   `vitest.config.ts`, property tests, `app/worker/`, `app/public/_headers`; a "Workflow" section restates global
   rules; claims a merge queue. `app/README.md` claims the queue too.
6. `verify` skill cites line numbers; Suites table omits unit and property tests.
7. Root README says Node 24; `.nvmrc` and CI say 26.
8. `retries: 0` isn't explicit in `playwright.config.ts`.

## The landing flow (every big project)

1. One integration branch per project, `fleet/<topic>`, cut from `main`.
2. Each worker: own worktree, own PR into `fleet/<topic>`. Every PR runs full CI; once `ci` passes, a trusted
   workflow deploys a preview and comments its URLs. Worker PRs merge with a merge commit when CI and review are
   clean.
3. Final PR `fleet/<topic>` -> `main`: full CI on a branch that's up to date with `main`, Sonnet and Opus review,
   visual QA of changed screenshots, preview deploy.
4. QA gate: `qa-tester` drives the preview's immutable deployment URL against the project's browser scenarios, one
   screenshot per scenario, and must return PASS.
5. Ship recording: `ship.yml` runs the project's ship specs (`app/e2e/ship/<topic>.spec.ts`, one test per
   scenario) against that same deployment URL, video on at an explicit size, slowed for a person to follow, a title
   card per scenario rendered in the page. A host job stitches `reel.mp4` (desktop and phone on one canvas). The run
   fails on zero tests or a missing clip.
6. Ship packet to Wasim, only when everything automatic is green: head SHA, deployment URL, browser scenarios with
   PASS and a screenshot each, `reel.mp4` (embedded in chat), engineering items with their evidence (CI run, `gh`
   output, file links), review rounds, changed-checks list. Saved under the main checkout's `verify/<branch>/ship/`;
   the PR comment links the CI artifact only (public repo: no business detail).
7. Wasim approves that SHA in chat. A push after approval voids it. Merge:
   `gh pr merge <n> --squash --match-head-commit <sha>`, with a squash message that ends in a `Verified:` trailer.
8. Deploy the exact merge commit from a clean worktree (`npm run deploy`, manual until the production plan
   automates it), then run the ship specs against the production URL (a separate input, read-only scenarios) as a
   smoke check. A project that changes no app code skips 8.

Backend proof, once a backend exists: API-level Playwright `request` specs in the ship run, and traces that show the
network calls.

## Decisions

- D1 Integration branch `fleet/<topic>`. This repo is not a fleet repo: the stale `ci/fleet-install` branch (closed
  PR #1) carries a different ruleset design (merge-only, code-owner review, merge queue). D4 wins for now; making
  Inhouse a fleet repo later is its own decision and reconciles the two.
- D2 Workers Previews (`wrangler preview`, open beta), deployed by a trusted workflow. Fallback if the beta blocks:
  Version URLs (`wrangler versions upload --preview-alias`).
- D3 Public workers.dev preview URLs (invented data; noindex header).
- D4 Rulesets, committed as JSON in `.github/rulesets/` and applied with `gh api` (to change one: edit its file, then
  `gh api -X PUT repos/Useful-Build/inhouse/rulesets/<id> --input .github/rulesets/<name>.json`, ids from
  `gh api repos/Useful-Build/inhouse/rulesets`):
  - `main`: PR required, required checks `ci` and `pr-gates` with strict (branch up to date), squash only, no force
    push, no deletion, no bypass actors (agents act as the admin, so a bypass would void the gate).
  - `fleet/**`: PR required, required checks `ci` and `pr-gates`, not strict, merge commits only, no force push,
    `do_not_enforce_on_create: true` (a new branch at `main`'s head has no check runs), no deletion rule (it would
    block `delete_branch_on_merge` when the final PR merges).
  - No required approvals (GitHub won't let Wasim approve PRs his agents open as him; he approves in chat), no merge
    queue for now (CI is ~11 min).
- D5 Global skills (`change-loop`, `verification`, `repo-setup`, `fleet`, `qa-check`) are updated after this flow has
  shipped once (Phase 4), as an opt-in flow distinct from fleet policy.
- D6 Cloudflare token: one token for previews and (in the production plan) production deploys, made from the
  documented "Edit Cloudflare Workers" template and scoped to the one account and the organisation's zone. It goes
  through a secret card into GitHub environments `preview` and `production`, whose deployment branches are `main`
  only, with `CLOUDFLARE_ACCOUNT_ID` as an environment variable. Only trusted workflow code on `main` ever holds it.

## Work plan

### Phase 0: orchestrator, sequential
- A1 Push `fleet/setup-gaps` at `main`'s head (no new commit).
- A2 Apply both rulesets. Check: direct push to `main` rejected.
- A3 Token and account id into environments `preview` and `production` (D6).

### Phase 1: bootstrap PRs straight into `main`, two workers in parallel
These must be on `main` before the flow can run: `workflow_run` and `workflow_dispatch` only use workflow files from
the default branch.

| Worker | Job | Owns |
|---|---|---|
| W1 opus-worker | Preview pipeline. Spike first: one `wrangler preview --json` from CI to confirm the Preview URL, the immutable deployment URL, static assets, SPA fallback (deep link to `/#/chats/all` and a browser navigation to a non-root path), headers, and whether `preview_urls: false` blocks it (the production plan's deploy smoke needs Version URLs, so turn them on unless that exposes something); add the `previews` block and confirm it survives the Vite plugin's generated config. Then: `ci.yml` uploads the built app (no secrets in that job) and gets the `pr-gates` fixes (property-test pathspec as `':(glob)app/src/**/*.property.test.ts'`; the trailer check skips a PR only when `github.event.pull_request.user.login` is `dependabot[bot]`, which GitHub verifies, unlike commit author names; Dependabot arrives in the production plan). `preview.yml` on `workflow_run` of `ci` (success, same-repo PR only) runs from `main`, downloads the build, runs a pinned wrangler `preview --name pr-<n> --json`, comments the preview URL, deployment URL and head SHA in one updated comment. Only the comment step gets `pull-requests: write`. `preview-cleanup.yml` (daily cron plus dispatch) deletes previews of closed PRs with `--skip-confirmation`; missing previews are harmless. Deploy and delete share one concurrency group per PR. | `.github/workflows/ci.yml`, `preview.yml`, `preview-cleanup.yml`, `app/wrangler.jsonc` |
| W2 sonnet-worker | Ship recording. `playwright.config.ts`: explicit `retries: 0`; opt-in `ship-desktop` and `ship-phone` projects (`SHIP=1`) matching `e2e/ship/`, `BASE_URL` (no webServer when set), `video: { mode: 'on', size }` at each viewport, `launchOptions.slowMo`, their own timeout; normal projects ignore `e2e/ship/`. `e2e/ship/helpers.ts`: title card per test. `ship.yml` (workflow_dispatch: PR number and spec file; inputs validated, passed through `env`, never interpolated into scripts): job 1 reads the deployment URL and head SHA from the preview comment, checks out that SHA, runs the ship specs in the Playwright container with `contents: read` and no secrets; job 2 on the host installs ffmpeg and stitches `reel.mp4`; job 3 comments the artifact link. A sample `e2e/ship/example.spec.ts` proves it end to end on a real preview once W1 lands. | `app/playwright.config.ts`, `app/e2e/ship/`, `.github/workflows/ship.yml` |

W2 builds in parallel and merges after W1, once its end-to-end proof has run on a real preview.

### Phase 2: worker PRs into `fleet/setup-gaps`, in parallel (start once Phase 1 is on `main` and merged into the branch)
- PR0 orchestrator: this plan as `docs/plans/2026-11-19-setup-gaps.md`.
- W3 sonnet-worker: fixed waits (gap 3): Clock API for the tooltip delay, a condition wait in cross-screen; a rule in
  `scripts/check-app-rules.mjs` that fails on `waitForTimeout` and `setTimeout`-based waits in `e2e/`
  (`test.setTimeout` stays allowed). Owns those two specs and the script.
- W4 opus-worker: feature map (gap 2). Map existing coverage first (Help is in `cross-screen` and `no-persona`;
  settings pages may be in `menus`, `sample-data`, `no-persona`), write a medium-hard spec only for real gaps,
  reference `pages-polish.spec.ts` and `phone.spec.ts`, accurate Gaps section. Then `e2e/ship/setup-gaps.spec.ts`:
  the browser scenarios for this project's reel (the new and mapped Settings pages and Help, desktop and phone).
  Owns `feature-map.md`, the new specs, that ship spec. The revised map goes to Wasim for approval.
- Orchestrator: AGENTS.md (gap 5 and the landing flow in "How changes land here"), `verify` skill (gap 6, plus
  previews and ship), root README (gap 7), `app/README.md` (queue claim), the merge-queue comment and trigger note in `ci.yml` (after W1 merges).

### Phase 3: final PR `fleet/setup-gaps` -> `main`
Runs the landing flow end to end; the ship packet is the proof. No app code changes, so no production deploy.

### Phase 4: after Wasim approves and it merges
W5 sonnet-worker in the global agent rules repo: the flow into `change-loop`, `verification`, `repo-setup` (blueprints for
previews, ship recording, rulesets), `fleet` and `qa-check`, as an opt-in flow distinct from fleet policy. One
Sonnet review, merge, the local copy synced.

## Acceptance

Engineering items (evidence: `gh` output, CI runs, files):
1. Direct push to `main` is rejected; a PR into `main` that's behind `main`, or has failing or pending `ci` or
   `pr-gates`, can't merge; only squash is offered. On `fleet/**`: PR and both checks required, merge commits only,
   a new branch can be created, a merged branch can be deleted.
2. A same-repo PR gets one comment with a working preview URL, the immutable deployment URL and the head SHA;
   static assets, a deep link and a browser navigation to a non-root path load; a fork PR gets no deploy and no
   secrets.
3. Closed PRs' previews are deleted by the cleanup run; a PR closed during a deploy ends with no preview.
4. `ship.yml` on a PR produces the HTML report and `reel.mp4`, one titled clip per scenario, with the SHA on the title
   cards; it fails on zero tests or a missing clip; `npm run test:e2e` never runs `e2e/ship/`.
5. `npm run lint` fails on a `waitForTimeout` or `setTimeout` wait in `e2e/`; none remain; touched specs pass.
6. Editing a property test is flagged by `pr-gates`.
7. `retries: 0` explicit in the Playwright config.
8. AGENTS.md: every command runs; sensitive paths match `pr-gates` plus deploy config and the new workflows; no
   copied global rules; 100 lines or fewer. `app/README.md` has no queue claim.
9. `verify` skill has no line numbers; fresh-worktree load check answers YES.
10. README, `.nvmrc` and CI agree on Node 26.
11. Every nav page, Settings page and overlay has a feature-map entry; every spec is referenced or listed as manual
    (motion, ship); Gaps section accurate; Wasim approved the revised map.
12. The final PR's head SHA has a QA PASS, a ship packet and Wasim's approval, and merges with
    `--match-head-commit`.
13. The global agent rules merged and synced (`main...origin/main`, nothing ahead or behind).

Browser scenarios (QA gate and reel, desktop 1440x900 and phone 390x844): written in
`e2e/ship/setup-gaps.spec.ts` by W4, one per Settings page and the Help window added to the map, approved with the
map.

## Must not

No app behavior change; no baseline updates; no retries; no `pull_request_target`; no secret in a job that runs PR
code or in logs; no production deploy and no merge into `main` without Wasim's OK for that SHA; no `--admin` merges;
no global skill change before Phase 4.
