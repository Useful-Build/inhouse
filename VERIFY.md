# VERIFY.md - Inhouse

## 1. Verification principle

Never call a change done from reading code alone. Prove it by running the real app and automated checks, and report the exact commands and outputs. If you skipped a check, say which one and why. When a bug escapes, add a test or lint rule so it cannot return.

## 2. What tests to write

- E2E tests first: drive real user flows in Playwright with `retries: 0`, `forbidOnly` enforced in CI (`!!process.env.CI`), and zero fixed sleeps (`waitForTimeout` is banned by lint; use web-first assertions or `page.clock`). Update `FEATURE_MAP.md` for any user-facing change.
- Property tests (`fast-check`): for parsers, reducers, storage round-trips, and state logic, define invariants and failure modes before coding instead of writing trivial after-the-fact unit tests.
- Differential tests: when migrating a system or swapping a mock for a real implementation, run old and new on the same inputs and diff the outputs.

## 3. Booting and driving Inhouse

The build, preview and Playwright commands below run in GitHub CI and on cloud runners, not on Wasim's laptop (see §4 and §6). Run all commands in `app/`. Override `E2E_PORT` (default 5193), `E2E_PRODUCT_PORT` (5194), or `E2E_TEST_BUILD_PORT` (8787) in parallel worktrees so ports never clash. Note that `vite build --mode product*` skips `tsc`, so always run `npm run typecheck` too. Never run a demo build and a product build (or a preview) concurrently in the same checkout.

- Demo app: `npm run dev` (port 5173, demo switches on), `npm run preview` (Vite default port 4173), or `npm run build && npx vite preview --port 5193 --strictPort` (matches Playwright's default `E2E_PORT`; open `http://localhost:5193/?demo#/today` for Stage and Scenario controls). Routes are hashes (`#/today`, `#/library`, `#/approvals`, `#/routines`, `#/activity`, `#/tools`, `#/skills`, `#/usage`, `#/settings/<tab>`, `#/chats/all`, `#/chats/<id>`). Specs seed state via `fx.seed({ stage, scenario, theme, demo })` in `app/e2e/support/fx.ts`, never raw `localStorage`.
- Product build check: run `npm run build` (demo), `npm run build:product`, `npm run build:product-test`, and `npm run build:product-eval`, scan with `node scripts/check-product-build.mjs`, then run `E2E_PRODUCT=1 E2E_PREBUILT=1 npx playwright test --project=product`.
- Local test build (Worker + hub): `npm run build:product-test`, then `E2E_TEST_BUILD=1 npx playwright test --project=api --project=real-desktop --project=real-phone`. Starts a fresh migrated/seeded local D1 (`.wrangler/test-build`) and the connector hub on recorded Shopify fixtures (`app/test/upstreams/shopify/`, no real store login). Origins: `http://brand.localhost:<port>` and `http://inhouse.localhost:<port>`. Outside Playwright: `node e2e/support/test-build/serve.ts -- <command>`.
- Container features (chats, routines, evals): local test build cannot run container Bash. Deploy to sandbox via `gh workflow run test-deploy -R Useful-Build/inhouse-ops -f pr=<N> -f sha=<full-sha> -f containers=true` (optional `-f ship_spec=<file>`; recordings land in R2 with presigned link `SHIP_GET` in the reel job's log). Concurrency is per PR: after a failure, dispatch again rather than re-running. Wait for drain and warm-up, then run with `E2E_TEST_BUILD_REMOTE=1 BASE_URL=<brand> TEST_BUILD_INHOUSE_URL=<inhouse> TEST_ISSUER_PRIVATE_JWK_FILE=<key>`. Paid real-model runs require Wasim's OK.

## 4. Checks by change type

On the laptop, run only the light checks. Everything heavier runs in GitHub CI on the PR: push, then read the results from the CI logs and artifacts.

- Any TS, app, or server code (local): `npm run typecheck && npm run lint && npm run test:unit`
- UI screen or component (CI): the PR's E2E, a11y and visual jobs run the specs. Inspect the screenshots and visual diffs from the CI artifacts at 1440x900 and 390x844 in light and dark. Update Linux baselines only through `baselines.yml` in CI, and only for intentional changes after inspecting every diff (never commit `-darwin.png`).
- Builds, bundle guards, product and test-build projects (CI): never run locally; CI's `ci`, `e2e` and `test-build` jobs cover them.
- Hub or runner (local, light): `cd app/hub && npm run typecheck && npm run test:node` (plus `check-hub-build.mjs` and `check-hub-config.mjs wrangler.hub.jsonc` in `app/`); `cd app/runner && npm test && npm run typecheck && npm run check:zod`.
- Prompts and evals:
  - Eval harness: dry run with `node evals/run.ts --target fake --out <dir>` (no model, no cost). Real runs (`--target product --paid --budget <usd>`) require Wasim's OK; commit results under `app/evals/results/`.
  - Morning-check set: run `node evals/morning-check/run.mjs --target <origin> --out-dir evals/morning-check/results --sha <git-sha> --issuer-key-file <key> --aud <aud>` with `INHOUSE_EVAL_D1_NAME`, `INHOUSE_EVAL_WRANGLER_CONFIG`, and `CF_SANDBOX_ACCOUNT_ID` inline (see `run.mjs` header; `--cases` is `partial`, never a pass). Commit results in `app/evals/morning-check/results/<date>-<sha>.json`. After squash into `main`, re-run against the eval brand (bounded by its $40 spending cap).
- Release smoke (read-only): `E2E_TEST_BUILD=1 npx playwright test --project=smoke`, or against a live release with `SMOKE_BASE_URL=<url>` and the Access service-token env vars (`SMOKE_CLIENT_ID`, `SMOKE_CLIENT_SECRET`, `MONITOR_CLIENT_ID`, `MONITOR_CLIENT_SECRET`).

## 5. Targeted live QA, visual proof, and milestones

- Targeted live QA (every user-facing or agent-behavior PR, before merge): run the PR itself on its Workers Preview deployment URL (or the PR sandbox deploy for container/agent behavior), never a local build and exercise the exact flow or bug you changed like a real user. Confirm it works end to end before merging to `main`, and note the proof in the PR or report (for example: `Live QA: PASS - reproduced X, verified fix works on Y`). No separate QA subagent is needed.
- Visual proof (UI changes): inspect every screenshot from CI's artifacts or the preview deploy (1440px and 390px, light and dark) and fix any clipping, overflow, contrast, or wrapping issue it reveals. For animated transitions, check frame-by-frame rather than spaced screenshots (`MOTION=1 npx playwright test --project=motion` for 30 fps scroll). Keep any artifacts you download in gitignored `verify/<branch>/`.
- Milestone QA only: reserve full multi-screen acceptance checklists and `ship.yml` video recordings (`gh workflow run ship -f pr=<n> -f spec=<file>`) for major milestone releases or big features, not everyday PRs.

## 6. Local machine guardrails

Wasim's laptop (a 16 GB Mac) runs only light checks (`typecheck`, `lint`, `test:unit`, hub and runner unit tests), through `~/.agents/tools/light-lock.sh` so parallel sessions don't run out of memory. Heavy jobs (builds, Playwright, Docker, workerd bundles, visual baselines, QA screenshots) run in GitHub CI, never on the laptop. The one exception: a dev server (through `~/.agents/tools/heavy-lock.sh`) when Wasim asks to see the app on localhost. Cloud and CI runners run everything and skip the locks.
