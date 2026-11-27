# AGENTS.md - Inhouse

## 1. What this repo is

Inhouse is a React 19 single-page app served by Cloudflare Workers for brand operations. It ships a demo build on invented sample data and a product build backed by a Cloudflare Worker, Durable Objects, D1, R2, a container runner, and an isolated connector hub.

## 2. Repo guides (read when relevant)

This file stays short on purpose. The repo uses 5 core root files; load the matching guide before acting in its area:

- `VERIFY.md`: how to boot, seed, run every test suite, and run live QA / visual proof.
- `REVIEW.md`: risk tiers, sensitive paths, severity rules, and PR review workflow (always read from `main`).
- `DESIGN.md`: design bar, `ui-base` tokens, dark mode, components, and UI copy rules.
- `FEATURE_MAP.md`: every screen, flow, selector, expected behavior, E2E spec coverage, and known gaps. Read the relevant section before changing a UI screen, user flow, or E2E spec; update its `Expected`, `Covered`, or `Gaps` lines in the same PR for any user-facing change.
- Deep reference lives in `docs/` only (read only when working in that area): `docs/architecture.md`, `docs/runbook.md`, `docs/decisions/`, `docs/plans/`, `docs/adopted-libraries.md`. Do not add extra guide files to the repo root.
- Global overrides: this repo intentionally has no `.agents/skills/verify` directory (`VERIFY.md` and `FEATURE_MAP.md` replace it — do not recreate it). `REVIEW.md` and Section 5 below replace global change-loop review tables and round limits here.

## 3. Stack and layout

React 19, TypeScript, Vite, Tailwind v4, shadcn/ui on Radix, zustand, Cloudflare Workers, Playwright, Vitest with fast-check, oxlint. Node 26 (`app/.nvmrc`), npm.

- `app/src/`: SPA code. `agent/` holds the `AgentClient` seam, mock client, and `http/` real client. `ui/` holds app wrappers; `components/ui/` is base-owned.
- `app/shared/`: zod schemas and shared types for everything the client and server exchange.
- `app/server/`: product Worker (auth, D1 layer, API handlers, Durable Objects, migrations, prompts).
- `app/hub/` and `app/runner/`: standalone packages with their own `package.json` and test suites.
- `app/e2e/`, `app/evals/`, `app/ops/tables/`: Playwright specs, eval harness, and storage registry.

## 4. Commands

Run in `app/` unless noted. Ports, env flags, and sandbox commands are in `VERIFY.md`.

**Where checks run:** on Wasim's laptop, run only the light checks (typecheck, lint, unit and property tests, hub and runner unit tests). Builds, bundle guards, E2E, a11y, visual baselines, the product and test-build projects, and screenshots or live QA run in GitHub CI on the PR (or on the PR's preview or sandbox deploy), never locally. Read results from the CI logs and artifacts. Cloud and CI runners may run everything. The one exception on the laptop: `npm run dev` only when Wasim asks to see the app on localhost, through `~/.agents/tools/heavy-lock.sh`.

- Dev (laptop only when Wasim asks): `npm run dev` (port 5173)
- Typecheck and lint (local): `npm run typecheck && npm run lint`
- Unit and property tests (local): `npm run test:unit` (Vitest + in-process workerd)
- Hub and runner unit tests (local): `cd app/hub && npm run typecheck && npm run test:node`; `cd app/runner && npm test`
- Builds (CI): `npm run build` (demo), `npm run build:product`, `npm run build:product-test`, `npm run build:product-eval`
- Bundle and config guards (CI): `node scripts/check-product-build.mjs`, `node scripts/check-hub-build.mjs`, `node scripts/check-hub-config.mjs wrangler.hub.jsonc`
- E2E, a11y and visual (CI): the `e2e` jobs run every Playwright project (`npx playwright test --fully-parallel --shard=n/4`), visual and a11y included; baselines update through `baselines.yml`. To re-check only some tests in CI, dispatch `targeted.yml` (`VERIFY.md` §4)

## 5. How work lands here

Work end to end without check-ins on routine steps. Use one strong model by default; fan out subagents only when a task cleanly splits into independent files. Fleet repo: no (`fleet/<topic>` is only an integration branch name here; global fleet rules and `--admin` merges do not apply).

1. Branch and commits: always work on a feature branch (never commit or push directly to `main`). Use conventional commits. Every non-merge commit must end with a trailer-only last paragraph containing `Verified: <what you ran>` (no blank line between trailers; `.githooks/commit-msg` enforces this locally after `npm install` in `app/`, and `pr-gates` enforces it in CI).
2. Build and prove: keep edits surgical and fail loud. Run the light checks locally before opening a PR, let CI run the heavy suites, and do targeted live QA on the PR's preview or sandbox deploy before merge (`VERIFY.md`). Never silence errors or weaken an existing check to make a change pass. Update `FEATURE_MAP.md` for any user-facing change. Re-runs follow `VERIFY.md` §4: narrow to fix, wide to prove, and the wide proof runs once, on the final commit, started by the pipeline itself. Never dispatch a full CI run to prove a small fix; prove it with a targeted run and let the PR's required run (or the merge queue's) be the full proof. Paid evals still need Wasim's OK on the cap.
3. Clean before review: before asking for review (and again before merge), remove what only served the work on this branch: handoff notes, scratch files, temporary mockups and screenshots, logs, debug code, and work-in-progress notes or TODOs this branch added. Temporary material lives in gitignored `verify/<branch>/` or outside the repo, never in a commit. What stays is what the base branch needs: code, tests, baselines, `FEATURE_MAP.md` and docs updates, plans and the active multi-PR tracker, design references a plan or doc links to, decision records, and committed eval results. A finished multi-PR tracker moves to `docs/history/`. Run `git diff --name-status <base>...HEAD` against the PR's base branch and drop any file that doesn't belong.
4. Review by lane: follow `REVIEW.md` on `main`. Lane 1 (Low) needs no separate reviewer. Lane 2 (Normal) gets 1 fresh-context Opus 5.5 (high) review. Lane 3 (High) gets Fable 5.2 (high) + Gemini 4 Neon (high, or the fallback in `REVIEW.md`). Only Lane 4 items (the referee, the rules, secrets and trust boundaries, money and irreversible steps, the plan) need Wasim's OK; batch them, and send blockers at once. Reviews stop at 3 rounds (`REVIEW.md` §4).
5. Stuck rule: if a check or bug fails twice (for CI, 1 fix push or re-run = 1 round per check; CI environment config is Lane 4), escalate once to **Fable 5.2 (high)** (or **Gemini 4 Carbon** if Fable is unavailable). If it still fails, stop and send Wasim a short plain report (what failed, what you tried, why it is stuck, user impact).
6. Merge and ship: work lands straight into `main` in small PRs, through the merge queue (decision 0028): `ci`, `pr-gates` and `gate` green, every `e2e`, `test-build`, `runner` and `hub` job a **pass (not skipped)** except on a docs-only PR, the lane's reviews done. Arm auto-merge only after that, on the exact head (`gh pr merge <n> --auto --match-head-commit <sha>`; `--disable-auto` before any later push). Never update a branch from `main` just to merge; the queue tests each PR on top of `main`. The agent that merged watches `deploy.yml` pass on `main` and cleans up its worktrees. If a merge breaks production, roll back as a stopgap, then land a revert PR through the queue (a rollback holds only until the next merge). When a milestone's last PR lands, send Wasim one message: the milestone's ship reel (`ship.yml`) plus the next milestone's plan and Gate ledger; it's a review, not a merge gate. Use `fleet/<topic>` only for work that must land all at once (the plan says so): feature PRs merge into `fleet/<topic>` with merge commits; never retarget a fast-path `fleet/**` PR directly to `main` without triggering full CI; the final PR into `main` needs the ship reel and Wasim's yes on its content (the `wasim-approved` label, which survives pushes that touch no Lane 4 item).

## 6. Repo invariants (do not break)

- Auth boundary: every `/api/*` route passes through Access JWT, Origin check, `server/routes.ts`, and `server/access-matrix.ts`.
- Build isolation: import the test issuer only as `@test-issuer`, eval trace only as `@eval-trace`, and test controls only as `@test-controls`. Never import them by file path.
- Secrets and environment: keep account IDs, hosts, store logins, and secrets out of this repo. Never run bare `env`, `printenv`, or `set` in shell commands (pass env vars inline instead so session tokens never print to logs).
- Data and migrations: sample data stays 100% invented. Migrations in `app/server/migrations/` are forward-only (never drop or rename in the release that stops using a column). Register every new D1 table, DO store, or R2 prefix in `app/ops/tables/`.
- Hub isolation: code bundled into `app/hub/` from outside it (such as `app/test/upstreams/`) imports no npm packages. The hub never exposes a public route.
- Prompts and evals: eval results are versioned and never deleted. Any edit to `app/server/prompt/` runs the eval suite and the morning-check set (`VERIFY.md`) and commits the results files.
- CI and deploys: never enable GitHub Actions cache in workflows (if adding `packageManager` or `devEngines.packageManager` to `app/package.json`, add `package-manager-cache: false` to every `setup-node` step first). Candidate deploys go to the separate sandbox account only; nothing from `fleet/*` deploys to house or a brand account. Never deploy production from a laptop (`deploy.yml` owns production; brand releases run from the private ops repo).
