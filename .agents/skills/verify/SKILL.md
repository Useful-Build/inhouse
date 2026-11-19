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

## Demo and seed switches

- Open any build with `?demo` (for example `http://localhost:5193/?demo#/today`) to show the demo switcher: Stage (Watch, Act, Run), Scenario (Normal, First day, Loading, Tool disconnected, Cap reached), dot sweep, the agent's mark and Reset demo. Code: `app/src/shell/demo.ts`, `app/src/shell/DevSwitcher.tsx`.
- Specs seed the switches in `localStorage` before the page loads: `inhouse.demo.switches.v1` = `{"stage":"Act","scenario":"Normal","ambient":"Always","animateMark":false}`.
- Other keys: agent state `inhouse.demo.v2`, run-to-trace map `inhouse.demo.runs.v1`, UI session `inhouse.ui.session.v1`, sidebar `inhouse.ui.sidebar.v1`, theme `inhouse.theme` (`light` or `dark`; absent means system), per-model `tm:<id>:effort` and `tm:<id>:on` (`app/README.md`, "The mock agent, and how phase 2 swaps it": the Phase 1 memory and Models bullets). Reset demo clears them and returns to Act and Normal.
- Theme in a seeded run: set `inhouse.theme` in the same init script (`page.addInitScript`) and call `page.emulateMedia({ colorScheme })` with the same value, as `e2e/states.ts` (`openState`) does. The key is `THEME_KEY` in `app/src/lib/theme.ts`.
- Routes are hashes: `#/today`, `#/library`, `#/approvals`, `#/routines`, `#/activity`, `#/tools`, `#/skills`, `#/usage`, `#/settings/<tab>`, `#/chats/all`, `#/chats/<id>`.

## Drive

- Test account: none. The app runs on invented mock data, nothing real is connected.
- Check at 1440x900 (desktop) and 390x844 (phone), in light and dark.

## Suites

Projects are in `app/playwright.config.ts`.

| Suite | Command | Notes |
|---|---|---|
| unit and property | `npm run test:unit` | Vitest with fast-check, `src/**/*.property.test.ts`. Light job. |
| desktop and phone E2E | `npm run test:e2e` | Every project. On macOS the visual projects match nothing and warn. On Windows they run against Linux baselines and fail: run `npx playwright test --project=desktop --project=phone --project=a11y` there. Specs with `phone` in the file name run in the `phone` project. |
| one spec | `npx playwright test e2e/<name>.spec.ts --project=desktop` | |
| visual | `npm run test:visual:linux` | Docker only on the Mac (and Windows). Baselines are `-linux.png`; never write a `-darwin.png`. |
| update baselines | `npm run test:visual:linux:update` | On purpose only. Or run the `baselines` workflow in CI. |
| a11y (axe, WCAG 2.1 A and AA) | `npm run test:a11y` | Desktop size. |
| motion (30 fps) | `MOTION=1 npx playwright test --project=motion` | Manual (`motion.yml`), never in CI's normal run. |
| ship recording | `SHIP=1 BASE_URL=<deployment url> npx playwright test e2e/ship/<spec> --project=ship-desktop --project=ship-phone` | Against a deployed preview, video on and slowed. In CI: `gh workflow run ship -f pr=<n> -f spec=<file>`; the `ship-pr-<n>` artifact holds `reel.mp4` and the report. Convention: `app/e2e/ship/README.md`. |

## Previews

Every same-repo PR gets a Workers Preview once `ci` passes. Its comment (marked `<!-- inhouse-preview -->`) gives the preview URL (follows the PR), the deployment URL (fixed to one commit: use this for QA and the ship recording) and the head SHA. Open it with `?demo` like any build. Fork PRs get none.

## Artifacts

`VERIFY_DIR` sets the output folder (default `e2e-artifacts/`): `report/index.html` is the HTML report, `results/` holds traces, videos and screenshots. File a run's artifacts under the main checkout's `verify/<branch>/`, as the `verification` skill says.

## Heavy jobs

Builds, previews, Playwright and Docker on the Mac go through `~/.agents/tools/heavy-lock.sh` (global `heavy-jobs`). Typecheck and lint go through `~/.agents/tools/light-lock.sh`.

## Feature map

[feature-map.md](feature-map.md) lists what each screen does and what the specs check.
