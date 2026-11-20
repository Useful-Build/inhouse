# Agent guide

Rules for coding agents working in this repo. Read `app/README.md` for how the app works before you change it.

## Layout

- `app/` is the whole app: a React single-page app served by a Cloudflare Worker.
- `app/src/agent/` holds the `AgentClient` interface, the mock agent and its sample data (`sample-data/`, invented).
- `app/src/ui/` holds the app's own components, `app/src/components/ui/` the base's shadcn components.
- `app/e2e/` holds the Playwright specs and the visual baselines; `app/e2e/ship/` the ship recording specs.
- `docs/plans/` holds the approved plans. `.github/rulesets/` holds the branch rulesets as applied.

## Stack

React 19, TypeScript, Vite, Tailwind v4, shadcn/ui on Radix, zustand for UI state, Cloudflare Workers, Playwright,
Vitest with fast-check, oxlint. Node 26 (`app/.nvmrc`). Package manager: npm.

## Commands

Run them in `app/`.

| Command | What it does |
|---|---|
| `npm ci` | Install dependencies |
| `npm run dev` | Dev server on port 5173 |
| `npm run typecheck` | `tsc -b` |
| `npm run lint` | oxlint, then `lint:tokens` (the token, app and no-fixed-wait checks) |
| `npm run test:unit` | Vitest: the property tests in `src/**/*.property.test.ts` |
| `npm run build` | Type check and production build |
| `npm run preview` | Build, then serve the build |
| `npm run test:e2e` | Every Playwright project against the production build (macOS skips the visual ones) |
| `npm run test:visual:linux` | The visual suite in the Playwright Docker image (`:update` regenerates baselines) |
| `npm run test:a11y` | axe, WCAG 2.1 A and AA |
| `npm run deploy` | Build and deploy to the Cloudflare account wrangler is signed in to (a fork's own). Don't use it for this repo's production: that's `deploy.yml` |

How to boot, drive and verify the app (ports, env switches, seeds, previews, the ship recording) is in the `verify`
skill (`.agents/skills/verify`).

## Done means

`npm run typecheck`, `npm run lint` and `npm run test:unit` pass, and the E2E suite passes in CI for anything that
changes behaviour or looks. A user-facing change also updates the feature map
(`.agents/skills/verify/feature-map.md`).

## Repo-only rules

- Keep the sample data invented. No real names, customers, emails, URLs or secrets.
- No fixed waits in `app/e2e/`: wait on a condition or use the Clock API. `lint:tokens` fails on them.

## Design system

Rules are in `app/DESIGN_SYSTEM.md` (base-owned) and `app/DESIGN_APP.md` (this app's layer). Load the `ui-foundation`
skill before any UI change. Repo specifics:

- `lint:tokens` runs `scripts/check-tokens.mjs` (no color literals outside `src/ui-base.css` and `src/index.css`) and
  `scripts/check-app-rules.mjs` (no arbitrary Tailwind values outside `src/components/ui/`, no literal inline styles
  in `.tsx`, no fixed waits in `e2e/`).
- A new `--app-*` token goes in `src/index.css` (`:root` and `.dark`, mapped in `@theme inline`) and in
  `src/lib/merge-config.ts` so `cn()` keeps it.
- Never edit `src/ui-base.css` or `src/components/ui/` (except `icon.tsx`). An app-only look goes in a `src/ui`
  wrapper. Screens use `src/ui`, icons go through `<Icon name="..." />`.
- Menus, dialogs, popovers, sheets, tooltips and accordions are Radix components.
- Dark is decided per token, not inverted. Check every change in light and dark, on desktop and on a 390px phone.
- A change meant to show runs `npm run test:visual:linux:update`, and the new baselines are committed with it. Never
  update baselines to hide an unexplained failure.

## How changes land here

- **CI gates:** rulesets (`.github/rulesets/`) require a PR and the checks `ci` and `pr-gates` on `main` and
  `fleet/**`, with no bypass. `ci` (typecheck, lint, unit, build, every Playwright project) runs on every PR into
  either. `pr-gates` fails a commit without a `Verified:` trailer and flags changed existing checks. `main` also needs
  the branch up to date with `main`. No merge queue for now.
- **Big projects:** one integration branch `fleet/<topic>` cut from `main`. Each piece is its own PR into it, merged
  with a merge commit. Bring `main` into it through a PR (direct pushes are blocked). The final PR into `main` gets
  full CI, reviews, a preview, the QA gate and a ship recording (`ship.yml`, run by hand with the PR number and its
  ship spec). Wasim approves that head SHA, then it squash-merges with `--match-head-commit <sha>` and a squash
  message ending in a `Verified:` trailer. A push after approval voids it. Plan:
  `docs/plans/2026-11-19-setup-gaps.md`.
- **Escalation (Wasim, 2026-11-20), for every task in this repo:** no problem loops. A round is one fix and one
  re-check, whether the problem came from a review, the QA gate, a live check or CI. Any problem, failing check or bug
  still open after two rounds goes to Claude Fable 5.2 at xhigh (the `fable-solver` role, its brief naming the files
  and every attempt so far with its result) for one round. If that fails, it goes to GPT 6.2 Sol at xhigh, headless
  through T3's Pi instance (never Codex), for one round, with Fable's attempt added. The orchestrator runs the
  escalation; a reviewer or delegate reports back instead. An escalated fix gets the normal review for its piece and
  the round count doesn't restart. If GPT's round fails too, stop on that item and keep working on everything that
  doesn't depend on it. Send Wasim a report, headed "Stuck after escalation", that says in plain language: what the
  problem is; what was tried (each round and model, and its result); why it still isn't fixed; whether it's a
  must-have or a nice-to-have for the task or the app; whether it's an edge case or the main case. Wasim decides. This
  replaces the change loop's three-round limit in this repo.
- **CI rounds (Wasim, 2026-11-20).** A worker fixing its own CI stops and reports back once a check it's fixing is
  still red after its second fix push; the orchestrator then escalates as above. Rounds count per check: a new error
  on the same check, or a re-run without a push, is still a round; a check that first goes red after a push starts at
  round 1. A change to the CI environment (host settings, sysctls, runner config) is never a worker's fix: the worker
  proposes it in its report and the orchestrator decides with the PR's review. A spike brief may set a larger budget
  (for example 4 rounds); once it's spent the worker reports back and the escalation above runs from there.
- **Previews:** every same-repo PR (not Dependabot's) gets a Workers Preview once `ci` passes (`preview.yml`, trusted
  code from `main` in environment `preview`), and one PR comment with its preview URL, its fixed deployment URL and
  the head SHA.
  `preview-cleanup.yml` deletes previews of closed PRs daily.
- **Deploys:** every push to `main` deploys that commit to production (`deploy.yml`, environment `production`):
  upload a version, smoke its Version URL, promote it, smoke the live hostname, tag a release `vYYYY.MM.DD.N`. Roll
  back with `gh workflow run deploy -f rollback_to=<version-id>`. `monitor.yml` checks production hourly and opens a
  `Production check failing` issue on a failure. Steps for an incident: `docs/runbook.md`. Nobody deploys
  production from a laptop.
- **After merge into `main`:** watch that commit's `deploy` run go green.
- **No Actions cache:** no workflow restores an Actions cache (`actions/cache`, `setup-node`'s `cache:`), so a PR
  run can't poison what a trusted run on `main` restores. A `packageManager` or `devEngines.packageManager` field in
  `app/package.json` turns on setup-node's automatic npm cache: add `package-manager-cache: false` to every
  setup-node step first.
- **Sensitive paths (need Wasim's OK):** `.github/workflows/` (deploy, monitor and the preview workflows included),
  `.github/rulesets/`, `app/playwright.config.ts`, `app/vitest.config.ts`, `app/e2e/` (specs, helpers, ship specs,
  `visual.spec.ts-snapshots/`), `app/src/**/*.property.test.ts`, `app/scripts/` (the lint, icon, bundle and ship
  scripts), `app/wrangler.jsonc`, `app/worker/`, `app/public/_headers`.
- **Shared ports:** dev 5173, E2E preview 5193 (`E2E_PORT`). Give each parallel worktree its own `E2E_PORT`.
- **Fleet repo:** no. `fleet/<topic>` is only the integration branch name here.
