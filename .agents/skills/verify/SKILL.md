---
name: verify
description: How to boot, drive and verify the Inhouse app. Load before running, driving, screenshotting or testing it, or before calling a change to it verified.
---

# Verify Inhouse

What counts as verified is the global `verification` skill. This is how to do it here. Run everything in `app/`.

## Boot

- The app is verified as a production build: `npm run build`, then `npx vite preview --port 5193 --strictPort` (`npm run preview` builds and serves).
- `npm run dev` serves on 5173 and shows the demo switches without `?demo`.
- The Playwright config starts its own preview. `E2E_PORT` moves it (default 5193). `E2E_PREBUILT=1` serves the existing `dist/` instead of building again.
- Parallel worktrees: give each its own `E2E_PORT`.
- The product build: `npm run build:product` (into `dist-product/`), then `E2E_PRODUCT=1 E2E_PREBUILT=1 npx playwright test --project=product` (it serves the build with `wrangler dev` on `E2E_PRODUCT_PORT`, default 5194; every URL shows "Not connected yet" and `?demo` does nothing). The product build puts the demo's deploy pointer back when it ends, so `vite preview` keeps serving `dist/`. `node scripts/check-product-build.mjs` checks both builds (and, since P2, the server bundle scan: run `npm run build:product-test` first). Since P2 the product build is the product Worker (`server/`, `wrangler.product.jsonc`), served from `dist-product/inhouse_product/wrangler.json`.
- The test build (P2): `npm run build:product-test` (into `dist-product-test/`), then `E2E_TEST_BUILD=1 npx playwright test --project=api --project=real-desktop --project=real-phone`. Its web server makes a fresh local D1 under `.wrangler/test-build` (migrated, then seeded), and serves the build with `wrangler dev` on `E2E_TEST_BUILD_PORT` (default 8787) with this run's test issuer key (public half only, as `--var TEST_ISSUER_JWKS`). Origins: `http://brand.localhost:<port>` and `http://inhouse.localhost:<port>`. Specs sign in with `signIn(memberKey, app)` from `e2e/support/test-build/`. Outside Playwright: `node e2e/support/test-build/serve.ts -- <command>` (the contract suite on the real client: `-- npx vitest run src/agent/contract`). Heavy job: through the heavy lock.

## Release smoke

`e2e/smoke/product.spec.ts` (project `smoke`, request only, read only, so it is safe on a release): as `smoke`, `/api/me` is 200 with the smoke member and `/api/settings/brand` parses; as `monitor`, `/api/health` is 200 and `/api/me` is 403; with no token, `/api/me` is 401. Every Worker answer carries the security headers.

- On the test build (CI runs it after the `api` project): `E2E_TEST_BUILD=1 npx playwright test --project=smoke` (heavy job: it starts `wrangler dev`). It signs in through the test issuer, like the `api` project.
- On a release: `SMOKE_BASE_URL=<release url> npx playwright test --project=smoke`, with `SMOKE_CLIENT_ID`, `SMOKE_CLIENT_SECRET`, `MONITOR_CLIENT_ID` and `MONITOR_CLIENT_SECRET` in the environment (Access service tokens, from the ops repo's secrets; never in this repo, a log or a command line you paste). No local server starts and nothing is recorded (no trace, video or screenshot), so the tokens can't land in an artifact. A missing variable fails the run and names it. With no token, Access itself refuses before the Worker runs, so that check accepts its 403 or redirect.
- Signing in as a seeded member on the test build: `signIn(memberKey, app)` in `e2e/support/test-build/issuer.ts` returns the `Cf-Access-Jwt-Assertion` header; `e2e/api/kit.ts` has `call(request, actor(who), method, path)` for the API.

## Demo and seed switches

- Open any build with `?demo` (for example `http://localhost:5193/?demo#/today`) to show the demo switcher: Stage (Watch, Act, Run), Scenario (Normal, First day, Loading, Tool disconnected, Cap reached), dot sweep, the agent's mark and Reset demo. Code: `app/src/shell/demo.ts`, `app/src/shell/DevSwitcher.tsx`.
- Specs seed the switches through `fx.seed({ stage, scenario, theme, demo: { ... } })` (`app/e2e/support/fx.ts`), never raw `localStorage`; `lint:tokens` fails on a spec that names an app key. The stored form is `inhouse.demo.switches.v1` = `{"stage":"Act","scenario":"Normal","ambient":"Always","animateMark":false}`.
- Other keys: agent state `inhouse.demo.v2`, run-to-trace map `inhouse.demo.runs.v1`, UI session `inhouse.ui.session.v1`, sidebar `inhouse.ui.sidebar.v1`, theme `inhouse.theme` (`light` or `dark`; absent means system), per-model `tm:<id>:effort` and `tm:<id>:on` (`app/README.md`, "The mock agent, and how phase 2 swaps it": the Phase 1 memory and Models bullets). Reset demo clears them and returns to Act and Normal.
- Theme in a seeded run: pass `theme` to `fx.seed`, or change it mid-test with `fx.setTheme(theme)`, and call `page.emulateMedia({ colorScheme })` with the same value, as `e2e/states.ts` (`openState`) does. The key is `THEME_KEY` in `app/src/lib/theme.ts`.
- Routes are hashes: `#/today`, `#/library`, `#/approvals`, `#/routines`, `#/activity`, `#/tools`, `#/skills`, `#/usage`, `#/settings/<tab>`, `#/chats/all`, `#/chats/<id>`.

## Drive

- Test account: none. The app runs on invented mock data, nothing real is connected.
- Check at 1440x900 (desktop) and 390x844 (phone), in light and dark.

## Suites

Projects are in `app/playwright.config.ts`.

| Suite | Command | Notes |
|---|---|---|
| unit and property | `npm run test:unit` | Vitest with fast-check: `src/**/*.test.ts` (property tests included), `build-support/`, and since P2 `server/`, `ops/`, `shared/` and `scripts/**/*.test.mjs`. Light job: `server/` tests run workerd in-process (no server). |
| test build: API and real app | `E2E_TEST_BUILD=1 npx playwright test --project=api --project=real-desktop --project=real-phone` | After `npm run build:product-test`. `e2e/api/` (Playwright `request`) and `e2e/real/` (browser, CSP guard). No other project runs them. |
| desktop and phone E2E | `npm run test:e2e` | Every project. On macOS the visual projects match nothing and warn. On Windows they run against Linux baselines and fail: run `npx playwright test --project=desktop --project=phone --project=a11y` there. Specs with `phone` in the file name run in the `phone` project. |
| one spec | `npx playwright test e2e/<name>.spec.ts --project=desktop` | |
| visual | `npm run test:visual:linux` | Docker only on the Mac (and Windows). Baselines are `-linux.png`; never write a `-darwin.png`. |
| update baselines | `npm run test:visual:linux:update` | On purpose only. Or run the `baselines` workflow in CI. |
| a11y (axe, WCAG 2.1 A and AA) | `npm run test:a11y` | Desktop size. |
| motion (30 fps) | `MOTION=1 npx playwright test --project=motion` | Manual (`motion.yml`), never in CI's normal run. |
| ship recording | `SHIP=1 BASE_URL=<deployment url> npx playwright test e2e/ship/<spec> --project=ship-desktop --project=ship-phone` | Against a deployed preview, video on and slowed. In CI: `gh workflow run ship -f pr=<n> -f spec=<file>`; the `ship-pr-<n>` artifact holds `reel.mp4` and the report. Convention: `app/e2e/ship/README.md`. |

## Previews

Every same-repo PR gets a Workers Preview once `ci` passes. Its comment (marked `<!-- inhouse-preview -->`) gives the preview URL (follows the PR), the deployment URL (fixed to one commit: use this for QA and the ship recording) and the head SHA. Open it with `?demo` like any build. Fork and Dependabot PRs get none.

## Artifacts

`VERIFY_DIR` sets the output folder (default `e2e-artifacts/`): `report/index.html` is the HTML report, `results/` holds traces, videos and screenshots. File a run's artifacts under the main checkout's `verify/<branch>/`, as the `verification` skill says.

## Heavy jobs

Builds, previews, Playwright and Docker on the Mac go through `~/.agents/tools/heavy-lock.sh` (global `heavy-jobs`). Typecheck and lint go through `~/.agents/tools/light-lock.sh`.

## Feature map

[feature-map.md](feature-map.md) lists what each screen does and what the specs check.
