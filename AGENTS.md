# Agent guide

Rules for coding agents working in this repo. Read `app/README.md` for how the app works before you change it.

## Layout

- `app/` is the whole app: a React single-page app served by a Cloudflare Worker.
- `app/src/agent/` holds the `AgentClient` interface, the mock agent and its sample data (`sample-data/`, invented).
- `app/src/ui/` holds the app's own components, `app/src/components/ui/` the base's shadcn components.
- `app/e2e/` holds the Playwright specs and the visual baselines.

## Stack

React 19, TypeScript, Vite, Tailwind v4, shadcn/ui on Radix, zustand for UI state, Cloudflare Workers, Playwright, oxlint. Package manager: npm.

## Commands

Run them in `app/`.

| Command | What it does |
|---|---|
| `npm ci` | Install dependencies |
| `npm run dev` | Dev server on port 5173 |
| `npm run typecheck` | `tsc -b` |
| `npm run lint` | oxlint, then `lint:tokens` (the token and app rule checks) |
| `npm run build` | Type check and production build |
| `npm run test:e2e` | Every Playwright project against the production build (macOS skips the visual ones; see below) |
| `npm run test:visual` | Visual regression suite, on Linux (CI, or inside the Playwright image); skipped on macOS |
| `npm run test:visual:update` | Regenerate the visual baselines on purpose, on Linux |
| `npm run test:visual:linux` | The visual suite in the Playwright Docker image, from any machine with Docker |
| `npm run test:visual:linux:update` | Regenerate the baselines in that image |
| `npm run test:a11y` | axe, WCAG 2.1 A and AA |

`E2E_PORT` sets the preview port for the E2E run and `VERIFY_DIR` where its artifacts go.

The visual baselines are Linux renders (`-linux.png`), made in the official Playwright image. On macOS the visual projects are skipped outside a container, so `test:e2e` runs the rest and nothing writes a `-darwin.png`; run the visual suite with `test:visual:linux`. On Windows, run the visual suite with `test:visual:linux`, and the rest with `npx playwright test --project=desktop --project=phone --project=a11y`.

CI (`.github/workflows/ci.yml`) runs on every pull request into `main` and `fleet/**` and in the merge queue: type check, lint, build and every Playwright project, in the Playwright image. Its `ci` check must pass to merge.

## Workflow

- Work on a branch and open a pull request. Never commit straight to `main`.
- Conventional commits: `feat(app): ...`, `fix(app): ...`, `docs: ...`.
- Before you call a change done: `npm run typecheck` and `npm run lint` pass, and the E2E suite passes for anything that changes behaviour or looks.
- Keep the sample data invented. No real names, customers, emails, URLs or secrets.

## Design system

The full rules are in `app/DESIGN_SYSTEM.md` (the base's guide, rewritten on every base update) and `app/DESIGN_APP.md` (this app's layer). In short:

- Use tokens only. Never hard-code a color, size or shadow in a screen. `lint:tokens` fails on color literals outside `src/ui-base.css` and `src/index.css`.
- A new value becomes an `--app-*` token in `src/index.css`, set in both `:root` and `.dark`, mapped in an `@theme inline` block, and listed in `src/lib/merge-config.ts` so `cn()` keeps it.
- Never edit `src/ui-base.css` or `src/components/ui/` (except `icon.tsx`). They're base-owned. An app-only look goes in a `src/ui` wrapper.
- On screens, use the `src/ui` parts, not `components/ui` directly. Menus, dialogs, popovers, sheets, tooltips and accordions are Radix components.
- No arbitrary Tailwind values outside `src/components/ui/` and no literal inline styles in `.tsx` (`check-app-rules.mjs`).
- Icons go through `<Icon name="..." />`. Never import an icon library in a component.
- Dark is decided per token, not inverted. Check every change in light and dark, on desktop and on a 390px phone.
- When a change is meant to show, run `npm run test:visual:linux:update` and commit the new baselines with it. Never update baselines to hide an unexplained failure.
