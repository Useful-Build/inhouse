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

## 3. Stack and layout

React 19, TypeScript, Vite, Tailwind v4, shadcn/ui on Radix, zustand, Cloudflare Workers, Playwright, Vitest with fast-check, oxlint. Node 26 (`app/.nvmrc`), npm.

- `app/src/`: SPA code. `agent/` holds the `AgentClient` seam, mock client, and `http/` real client. `ui/` holds app wrappers; `components/ui/` is base-owned.
- `app/shared/`: zod schemas and shared types for everything the client and server exchange.
- `app/server/`: product Worker (auth, D1 layer, API handlers, Durable Objects, migrations, prompts).
- `app/hub/` and `app/runner/`: standalone packages with their own `package.json` and test suites.
- `app/e2e/`, `app/evals/`, `app/ops/tables/`: Playwright specs, eval harness, and storage registry.

## 4. Commands

Run in `app/` unless noted. Ports, env flags, and sandbox commands are in `VERIFY.md`.

- Dev: `npm run dev` (port 5173)
- Typecheck and lint: `npm run typecheck && npm run lint`
- Unit and property tests: `npm run test:unit` (Vitest + in-process workerd)
- Builds: `npm run build` (demo), `npm run build:product`, `npm run build:product-test`, `npm run build:product-eval`
- Bundle and config guards: `node scripts/check-product-build.mjs`, `node scripts/check-hub-build.mjs`, `node scripts/check-hub-config.mjs wrangler.hub.jsonc`
- E2E and a11y: `npm run test:e2e`, `npm run test:a11y`, `npm run test:visual:linux`
- Hub and runner: `cd app/hub && npm run typecheck && npm run test:node`; `cd app/runner && npm test`

## 5. How work lands here

Work end to end without check-ins on routine steps. Use one strong model by default; fan out subagents only when a task cleanly splits into independent files.

1. Branch and commits: always work on a feature branch (never commit or push directly to `main`). Use conventional commits. Every non-merge commit must end with a trailer-only last paragraph containing `Verified: <what you ran>` (no blank line between trailers, or `pr-gates` fails).
2. Build and prove: keep edits surgical and fail loud. Run the relevant checks and targeted live QA in `VERIFY.md` before opening a PR. Never silence errors or weaken an existing check to make a change pass. Update `FEATURE_MAP.md` for any user-facing change.
3. Review by risk: follow `REVIEW.md`. Low-risk PRs need no separate reviewer. Normal PRs get 1 fresh-context Opus 5.5 (high) review. High-risk (sensitive) PRs get Fable 5.2 (high) + Gemini 4 Neon (high, when available) + Wasim's OK.
4. Stuck rule: if a check or bug fails twice, escalate once to a stronger model or higher effort (Fable 5.2 or Gemini 4 Carbon). If it still fails, stop and send Wasim a short plain report (what failed, what you tried, why it is stuck, user impact).
5. Merge and ship: squash-merge into `main` once CI (`ci` and `pr-gates`) is green, clean up temporary worktrees, and watch `deploy.yml` pass on `main`. Big multi-PR projects can use a `fleet/<topic>` integration branch when a plan calls for it (never retarget a fast-path `fleet/**` PR directly to `main` without triggering full CI).

## 6. Repo invariants (do not break)

- Auth boundary: every `/api/*` route passes through Access JWT, Origin check, `server/routes.ts`, and `server/access-matrix.ts`.
- Build isolation: import the test issuer only as `@test-issuer`, eval trace only as `@eval-trace`, and test controls only as `@test-controls`. Never import them by file path.
- Secrets and environment: keep account IDs, hosts, store logins, and secrets out of this repo. Never run bare `env`, `printenv`, or `set` in shell commands (pass env vars inline instead so session tokens never print to logs).
- Data and migrations: sample data stays 100% invented. Migrations in `app/server/migrations/` are forward-only (never drop or rename in the release that stops using a column). Register every new D1 table, DO store, or R2 prefix in `app/ops/tables/`.
- Hub isolation: code bundled into `app/hub/` from outside it (such as `app/test/upstreams/`) imports no npm packages. The hub never exposes a public route.
- Prompts and evals: eval results are versioned and never deleted. Any edit to `app/server/prompt/` runs the eval or morning-check set and commits the results file.
- CI and deploys: never enable GitHub Actions cache in workflows. Never deploy production from a laptop (`deploy.yml` owns production; brand releases run from the private ops repo).
