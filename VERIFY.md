# VERIFY.md - Inhouse

## 1. Verification principle

Never call a change done from reading code alone. Prove it by running the real app and automated checks, and report the exact commands and outputs. If you skipped a check, say which one and why. When a bug escapes, add a test or lint rule so it cannot return.

## 2. What tests to write

- E2E tests first: drive real user flows in Playwright with `retries: 0`, `forbidOnly` enforced in CI (`!!process.env.CI`), and zero fixed sleeps (`waitForTimeout` is banned by lint; use web-first assertions or `page.clock`). Update `FEATURE_MAP.md` for any user-facing change.
- Property tests (`fast-check`): for parsers, reducers, storage round-trips, and state logic, define invariants and failure modes before coding instead of writing trivial after-the-fact unit tests.
- Differential tests: when migrating a system or swapping a mock for a real implementation, run old and new on the same inputs and diff the outputs.

## 3. Booting and driving Inhouse

The build, preview and Playwright commands below run in GitHub CI and on cloud runners, not on Wasim's laptop (see §4 and §6). The one exception: `npm run dev` (through `~/.agents/tools/heavy-lock.sh`) when Wasim asks to see the app on localhost. Run all commands in `app/`. Override `E2E_PORT` (default 5193), `E2E_PRODUCT_PORT` (5194), or `E2E_TEST_BUILD_PORT` (8787) in parallel worktrees so ports never clash. Note that `vite build --mode product*` skips `tsc`, so always run `npm run typecheck` too. Never run a demo build and a product build (or a preview) concurrently in the same checkout.

- Demo app: `npm run dev` (port 5173, demo switches on; on the laptop only when Wasim asks), `npm run preview` (Vite default port 4173), or `npm run build && npx vite preview --port 5193 --strictPort` (matches Playwright's default `E2E_PORT`; open `http://localhost:5193/?demo#/today` for Stage and Scenario controls). Routes are hashes (`#/today`, `#/library`, `#/approvals`, `#/routines`, `#/activity`, `#/tools`, `#/skills`, `#/usage`, `#/settings/<tab>`, `#/chats/all`, `#/chats/<id>`). Specs seed state via `fx.seed({ stage, scenario, theme, demo })` in `app/e2e/support/fx.ts`, never raw `localStorage`.
- Product build check (CI's `e2e (1/2)` job): run `npm run build` (demo), `npm run build:product`, `npm run build:product-test`, and `npm run build:product-eval`, scan with `node scripts/check-product-build.mjs`, then run `E2E_PRODUCT=1 E2E_PREBUILT=1 npx playwright test --project=product`.
- Test build (Worker + hub; CI's `test-build` job runs it, not the laptop): `npm run build:product-test`, then `E2E_TEST_BUILD=1 npx playwright test --project=api --project=real-desktop --project=real-phone`. Starts a fresh migrated/seeded local D1 (`.wrangler/test-build`) and the connector hub on recorded Shopify fixtures (`app/test/upstreams/shopify/`, no real store login). Origins: `http://brand.localhost:<port>` and `http://inhouse.localhost:<port>`. Outside Playwright: `node e2e/support/test-build/serve.ts -- <command>`.
- Container features (chats, routines, evals): local test build cannot run container Bash. Deploy to sandbox via `gh workflow run test-deploy -R Useful-Build/inhouse-ops -f pr=<N> -f sha=<full-sha> -f containers=true` (optional `-f ship_spec=<file>`; recordings land in R2 with presigned link `SHIP_GET` in the reel job's log). Add `-f specs=true` and the workflow runs the `api` and `real-*` projects against the deploy after drain and warm-up (it sets `E2E_TEST_BUILD_REMOTE=1`, `BASE_URL`, `TEST_BUILD_INHOUSE_URL` and `TEST_ISSUER_PRIVATE_JWK_FILE` itself); don't run them from the laptop. Concurrency is per PR: after a failure, dispatch again rather than re-running. Paid real-model runs require Wasim's OK.

## 4. Checks by change type

On the laptop, run only the light checks. Everything heavier runs in GitHub CI on the PR: push, then read the results from the CI logs and artifacts.

- Any TS, app, or server code (local): `npm run typecheck && npm run lint && npm run test:unit`
- UI screen or component (CI): the `desktop`, `phone`, `visual-desktop`, `visual-phone` and `a11y` Playwright projects run inside the `e2e (1/2)` and `e2e (2/2)` jobs. For visual proof, see §5. Update Linux baselines only through `baselines.yml`, and only for intentional changes after inspecting every changed PNG (never commit `-darwin.png`).
- Builds, bundle guards, product and test-build projects (CI): never run locally. The `e2e (1/2)` job runs the builds, `check-bundle.mjs`, `check-product-build.mjs` and the `product` project; the `test-build` job runs the `api`, `real-*` and `smoke` projects; the `hub` job runs the hub bundles and their guards.
- Hub or runner (local, light): `cd app/hub && npm run typecheck && npm run test:node`; `cd app/runner && npm test && npm run typecheck && npm run check:zod`. The hub bundles, `check-hub-build.mjs` and `check-hub-config.mjs` need built bundles, so they run in CI's `hub` job, not locally.
- Fleet PRs: a PR into `fleet/<topic>` runs only CI's `fast`, `hub` and `runner` jobs; `e2e` and `test-build` are skipped. The heavy suites run on the push to `fleet/<topic>` (each merge) and on the final `fleet/<topic>` PR into `main`.
- Prompts and evals:
  - Eval harness: dry run with `node evals/run.ts --target fake --out <dir>` (no model, no cost). Real runs (`--target product --paid --budget <usd>`) require Wasim's OK; commit results under `app/evals/results/`.
  - Morning-check set: run `node evals/morning-check/run.mjs --target <origin> --out-dir evals/morning-check/results --sha <git-sha> --issuer-key-file <key> --aud <aud>` with `INHOUSE_EVAL_D1_NAME`, `INHOUSE_EVAL_WRANGLER_CONFIG`, and `CF_SANDBOX_ACCOUNT_ID` inline (see `run.mjs` header; `--cases` is `partial`, never a pass). Commit results in `app/evals/morning-check/results/<date>-<sha>.json`. After squash into `main`, re-run against the eval brand (bounded by its $40 spending cap).
- Release smoke (read-only, CI): CI's `test-build` job runs `E2E_TEST_BUILD=1 npx playwright test --project=smoke` on every PR into `main`. Against a live release it runs from the ops repo or another CI runner, never the laptop, with `SMOKE_BASE_URL=<url>` and the Access service-token env vars (`SMOKE_CLIENT_ID`, `SMOKE_CLIENT_SECRET`, `MONITOR_CLIENT_ID`, `MONITOR_CLIENT_SECRET`).

## 5. Targeted live QA, visual proof, and milestones

- Targeted live QA (every user-facing or agent-behavior PR, before merge): run the PR itself on its Workers Preview deployment URL (or the PR sandbox deploy for container/agent behavior), never a local build, and exercise the exact flow or bug you changed like a real user. Confirm it works end to end before merging to `main`, and note the proof in the PR or report (for example: `Live QA: PASS - reproduced X, verified fix works on Y`). No separate QA subagent is needed.
- Visual proof (UI changes): every CI run that isn't cancelled uploads its Playwright output as the `playwright-shard-<n>` and `playwright-test-build` artifacts. On a green run the shard artifacts hold the named screenshots specs take of the screens they test (`page.screenshot` into `outputPath`, mostly light, at the spec's width); `playwright-test-build` holds reports only. On a failing run both also hold the failure screenshots, traces and videos. Fix any clipping, overflow, contrast, or wrapping issue you find in these:
  - Any UI change: download the `playwright-shard-<n>` artifacts and inspect the screenshots of the screens you changed. For every state in light and dark at 1440px and 390px, use the visual baselines below (`visual.spec.ts` covers each state in both themes).
  - Intentional UI change: run `gh workflow run baselines --ref <branch>`. It uploads the new Linux PNGs as the `visual-baselines` artifact. Download them into `app/e2e/visual.spec.ts-snapshots/`, look at each one and commit them. Then inspect each changed PNG in the PR's file view (GitHub shows before and after).
  - Failing run: inspect the expected, actual and diff images in the same artifacts.
  - Flow check: use the PR's Workers Preview URL (the demo build, deployed by `preview.yml` after `ci` passes). For product or container behavior, use the ops-repo sandbox deploy (§3).
  - Animated transitions: check frame by frame, not with spaced screenshots. Run `gh workflow run motion --ref <branch>` (no inputs); it records 30 fps video and per-frame JSON at desktop and 390px and uploads them as the `motion` artifact, even on failure.
  - Keep any artifacts you download in gitignored `verify/<branch>/`.
- Milestone QA only: reserve full multi-screen acceptance checklists and `ship.yml` video recordings (`gh workflow run ship -f pr=<n> -f spec=<file>`) for major milestone releases or big features, not everyday PRs.

## 6. Local machine guardrails

Wasim's laptop (a 16 GB Mac) runs only light checks (`typecheck`, `lint`, `test:unit`, hub and runner unit tests), through `~/.agents/tools/light-lock.sh` so parallel sessions don't run out of memory. Heavy jobs (builds, the Worker and hub bundles, Playwright, Docker, visual baselines, QA screenshots) run in GitHub CI, never on the laptop. The one exception: a dev server (through `~/.agents/tools/heavy-lock.sh`) when Wasim asks to see the app on localhost. Cloud and CI runners run everything and skip the locks.
