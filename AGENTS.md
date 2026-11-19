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
| `npm run test:e2e` | Every Playwright project against the production build (macOS skips the visual ones) |
| `npm run test:visual` | Visual regression suite, on Linux (CI, or inside the Playwright image); skipped on macOS |
| `npm run test:visual:update` | Regenerate the visual baselines on purpose, on Linux |
| `npm run test:visual:linux` | The visual suite in the Playwright Docker image, from any machine with Docker |
| `npm run test:visual:linux:update` | Regenerate the baselines in that image |
| `npm run test:a11y` | axe, WCAG 2.1 A and AA |

How to boot, drive and verify the app (ports, env switches, seeds, the visual suite on macOS and Windows) is in the `verify` skill (`.agents/skills/verify`).

## Workflow

- Work on a branch and open a pull request. Never commit straight to `main`.
- Conventional commits: `feat(app): ...`, `fix(app): ...`, `docs: ...`.
- Before you call a change done: `npm run typecheck` and `npm run lint` pass, and the E2E suite passes for anything that changes behaviour or looks.
- Keep the sample data invented. No real names, customers, emails, URLs or secrets.

## Design system

Rules are in `app/DESIGN_SYSTEM.md` (base-owned) and `app/DESIGN_APP.md` (this app's layer). Load the `ui-foundation` skill before any UI change. Repo specifics:

- `lint:tokens` runs `scripts/check-tokens.mjs` (no color literals outside `src/ui-base.css` and `src/index.css`) and `scripts/check-app-rules.mjs` (no arbitrary Tailwind values outside `src/components/ui/`, no literal inline styles in `.tsx`).
- A new `--app-*` token goes in `src/index.css` (`:root` and `.dark`, mapped in `@theme inline`) and in `src/lib/merge-config.ts` so `cn()` keeps it.
- Never edit `src/ui-base.css` or `src/components/ui/` (except `icon.tsx`). An app-only look goes in a `src/ui` wrapper. Screens use `src/ui`, icons go through `<Icon name="..." />`.
- Menus, dialogs, popovers, sheets, tooltips and accordions are Radix components.
- Dark is decided per token, not inverted. Check every change in light and dark, on desktop and on a 390px phone.
- A change meant to show runs `npm run test:visual:linux:update`, and the new baselines are committed with it. Never update
  baselines to hide an unexplained failure.

## How changes land here

- **CI gates:** `ci.yml` runs on every PR into `main` and `fleet/**` and in the merge queue: typecheck, lint, build and every Playwright project, in the Playwright image (that's why the baselines are Linux). The `ci` check must be green to merge. The `pr-gates` job (Verified trailer, flagged check changes) runs on every PR. `baselines.yml` and `motion.yml` are manual only.
- **Deploys:** nothing deploys on merge. `npm run deploy` (in `app/`) is run by hand.
- **After merge:** none.
- **Sensitive paths (need Wasim's OK):** `.github/workflows/`, `app/playwright.config.ts`, `app/e2e/` specs and helpers, `app/e2e/visual.spec.ts-snapshots/`, `app/scripts/` (the lint checks), `app/wrangler.jsonc`.
- **Shared ports:** dev 5173, E2E preview 5193 (`E2E_PORT`). Give each parallel worktree its own `E2E_PORT`.
- **Fleet repo:** no, not yet.
