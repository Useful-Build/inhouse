# P1: the agent seam (`fleet/agent-seam`)

Status: locked and approved by Wasim, 2026-11-19. Phase plan under the backend plan
(`docs/plans/2026-11-19-backend.md`, "Phases" and "Phase schedule (waves)"). Common rules for every phase (landing,
reviews, seats, scrub) are in that schedule section and aren't repeated here.


Progress: tracked in the backend plan's "Implementation progress" section, entry P1. Read it before you start
and update it before you stop.
## Goal

Make the frontend ready for a real backend without changing what anyone sees. The mock keeps running the public demo,
the product build ships no mock, and one schema plus one contract suite hold the mock to the contract the real client
will meet in P2.

**Success measure:** the demo's visual suite passes with no baseline change, the contract suite passes on the mock
with every value parsed through the shared schema, and a check proves the product build has no sample data, mock code,
demo controls or demo clock in it.

## Scope

In:
- **C1** times and money. Every instant becomes `{ iso, ms }` (ISO 8601 string plus epoch ms). Every amount becomes
  `{ minor, currency }`. Wall-clock schedule times (a routine's "6:00 AM") become `{ hour, minute }` in the brand's
  time zone, and durations become ms. The UI formats all of them in one place (`src/lib/format.ts`), with US formats
  (decision log, "demo clock and locale").
- **C8** demo split. `setDemo`, `reset`, the scenario data and the data-override flag move from `AgentClient` to a
  `DemoControls` interface that exists only in the demo build. `store.ts` stops importing the mock. A build mode picks
  the client. The demo clock and the demo-only public files leave the product build too. A check fails the product
  build on sample data, mock code, demo controls or the demo clock.
- **C10** a fixtures layer for the specs. Specs read names and seed state through `e2e/support/`, never through
  sample strings or mock storage keys. A lint rule keeps it that way.
- **The shared schema folder** `app/shared/contract/`: zod schemas for every value and event the `AgentClient`
  returns. `src/agent/types.ts` re-exports the inferred types, so each type is defined once.
- **The contract suite on the mock** (Vitest): every read, write and run event parsed through the schema; stable
  snapshots; notices; optimistic rollback.
- **The product client stub** `src/agent/http/`: implements `AgentClient`; reads return `loading` and writes reject
  with `AgentError('unavailable')`. `unavailable` joins the error code enum now (C3 adds the rest in P2). The product
  shell shows one "Not connected yet" screen in place of the pages when the client reports it. P2 fills the client in.

Out: any backend, route or Worker change (P2); C2 to C7 and C9 (P2, P3, P6); deploying the product build anywhere.

## Inputs and gates

- Hardening (`fleet/hardening`) has merged into `main`: it touches `App.tsx`, `index.html`, `main.tsx`,
  `vite.config.ts`, the Worker and every spec (the CSP fixture). Cut `fleet/agent-seam` from `main` after that.
- The orchestrator re-reads hardening's merged `App.tsx`, `vite.config.ts`, `deploy.yml`, `public/` and the spec
  fixture at the Plan step and updates the briefs below if a path moved.
- No input from Wasim beyond approving this plan, which is also his OK for the sensitive paths named below
  (`app/e2e/`, `app/scripts/`, `app/vitest.config.ts`, `app/playwright.config.ts`, `.github/workflows/ci.yml`).
- **Test model (Wasim, 2026-11-19):** every test, eval, smoke or check in this phase that calls a real model runs on
  Sonnet 5.5 (`claude-sonnet-5-5`) at medium effort; everything else uses the scripted model. P1 calls no model.

## Design notes

- **`npm run build` stays the demo build.** CI, the visual suite, previews and hardening's `deploy.yml` keep building
  the demo with no workflow change. A new `npm run build:product` (`vite build --mode product`) builds the product
  into its own output folder; the orchestrator confirms the Cloudflare Vite plugin's output layout for a second mode
  against its current docs before choosing the folder.
- **The client is picked at build time, not at run time.** `src/agent/index.ts` imports from an alias `@client` that
  points at `src/agent/client.demo.ts` (mock plus `DemoControls`) or `src/agent/client.product.ts` (the HTTP stub).
  Both files end in `satisfies ClientEntry`, one type: `{ agent: AgentClient; demo: DemoControls | null; now(): number }`.
  The alias is set in three places: `vite.config.ts` (by mode), `tsconfig.app.json` paths and `vitest.config.ts` (both
  on the demo entry; `tsc -b` still checks both files, since both sit in `src/`). No runtime flag, so the bundler never
  sees the mock in product mode.
- `?demo`, the dev switcher, Reset demo and the tour's demo steps read `demo` and render nothing when it's `null`.
  `demoEnabled()` is false in the product build whatever the URL says.
- **Scenario data.** What a product screen needs from a scenario becomes a real state field (for example a tool's
  connection status with its `since` instant). What only the demo needs moves to `DemoControls`.
- **The clock seam.** Today `store.ts`, `derive.ts`, `Usage.tsx` and `settings/content.ts` import `DEMO_START` or
  `demoNow` from `src/agent/clock.ts`, so a product build would run on the demo's date. The demo clock moves to
  `src/agent/demo-clock.ts`, imported only by the demo entry and the mock. Everything else takes "now" from
  `ClientEntry.now()`: the demo clock in the demo, the real clock in the product.
- **The demo clock.** Sample data keeps relative offsets (minutes from the demo start, as `atMin` does today). The mock
  turns them into `{ iso, ms }` from the demo clock at load, so the demo still opens at 8:00 AM local time on
  Mon, Nov 16, 2026.
- **Formatting takes the zone and locale as arguments.** Every function in `format.ts` takes a `Display` value
  (`{ timeZone, locale }`), read from one selector. The demo fills it with the device's zone and `en-US`, so nothing
  changes on screen. The product fills it from the brand's time zone setting in P2 (routine slots in P4 and the brand's
  day in P7 depend on it). Wasim's decision Q9 (schedule): the date and number format for UK brands. Until he decides,
  the product passes `en-US`.
- **Demo-only public files.** Vite copies everything in `app/public/`, and `public/library/` and `public/avatars/` are
  sample files. PR0 moves them to `app/public-demo/`, copied to the same URLs only in demo mode, so the demo is
  unchanged and the product build ships neither.
- **The product build check** (`scripts/check-product-build.mjs`) has three parts. (1) Canary strings in the product
  output: the sample brand's name, distinctive full names from `sample-data/`, and marker constants exported by
  `mock.ts`, `demo-controls.ts` and `demo-clock.ts`. Canaries are unique strings only, never common words or method
  names that libraries also use. (2) The module graph: the product build writes its module list, and the check fails
  when any module under `src/agent/sample-data/`, or `mock`, `demo-controls`, `demo-clock` or `client.demo`, is in it.
  A string scan alone can't prove a tree-shaken or renamed import is gone. (3) Copied files: no `library/` or
  `avatars/` file in the output. It runs the same checks on the demo build and fails if they pass there, so it can't go
  green by scanning the wrong folder.
- **One formatting place, enforced.** `scripts/check-format.mjs` fails on `toLocale*`, `Intl.DateTimeFormat` or
  `Intl.NumberFormat` outside `src/lib/format.ts`; `lint:tokens` runs it. The formatters in `clock.ts` today move to
  `format.ts`.
- **A returning visitor keeps their demo.** C1 changes the shape of values the mock and the store keep in the browser
  under keys that don't change. Before any change, PR0 saves what today's `main` writes there (a started chat, a
  draft, the model pick, an approval mid-hold) as a fixture. An upgrade spec loads the new build over it and checks
  nothing is lost. The spec pins the clock: the demo clock and an approval's real-time hold are separate clocks.
- **zod** is the one new runtime dependency (latest major, exact version in the lockfile). Types only reach the demo
  bundle (`z.infer` is erased); the mock doesn't parse at run time, so hardening's bundle budget holds. The real client
  parses at the boundary from P2.
- **Contract suite shape.** `src/agent/contract/*.contract.test.ts` runs one suite over a list of targets. Each
  target gives `{ client, reset(), seed(state) }`. P1 has one target, the mock. P2 adds the real client under
  `wrangler dev` without changing the tests.
- **Fixtures layer shape.** `e2e/support/fx.ts` exports a Playwright fixture `fx` with `names` (brand, people, tools,
  chats from the client's seed), `seed({ stage, scenario })`, `seedRaw(stored)` and `reset()`.
  `e2e/support/clients/mock.ts` is the only file that knows the mock's storage keys. P2 adds `clients/real.ts`.

## Workers

Seats per the backend plan's schedule: C and D first. Workers run light checks only (type check, lint, unit) through
the light lock; Playwright runs in CI.

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| W1 | opus-worker (Opus 5.5, medium) | Two PRs. **First:** the shared schema for the whole current contract, `types.ts` re-exporting the inferred types, the field inventory (each field marked instant, money, schedule, duration or display text, in the PR body) and a golden file of today's display strings for every sample value, captured before any formatter changes. **Second:** C1 across the mock, sample data and the UI, `format.ts` with the `Display` argument and its selector, a differential test (the new formatter's output equals the golden file), and the format lint rule. | `app/shared/contract/**` (except `index.ts`), `src/agent/types.ts`, `src/agent/mock.ts`, `src/agent/data.ts`, `src/agent/clock.ts`, `src/agent/sample-data/**`, `src/lib/format.ts`, `src/lib/format.*.test.ts`, `src/state/display.ts`, the golden file, `scripts/check-format.mjs`, and the formatting call sites in `src/screens/**`, `src/overlays/**`, `src/ui/**`, `src/components/**`, `src/state/derive.ts` and `src/state/store.ts` | PR0 |
| W2 | sonnet-worker (Sonnet 5.5, medium) | C10 part 1: `e2e/support/` (fixture, mock client, `seedRaw`), the lint rule in `scripts/check-app-rules.mjs` (no `inhouse.demo.` storage keys and no sample-data imports in `e2e/` outside `e2e/support/`), then migrate batch A: `e2e/[a-m]*.spec.ts`. The support layer and the shared helpers (`states.ts`, `page-text.ts`, `pages-polish-checks.ts`, `today-approvals-helpers.ts`, which batch B imports) land together as W2's first PR, so W3 starts on settled helpers. | `app/e2e/support/**`, `app/scripts/check-app-rules.mjs`, the four helpers, batch A files | PR0 |
| W3 | sonnet-worker (Sonnet 5.5, medium) | C10 part 2: batch B, `e2e/[n-z]*.spec.ts` (with `visual.spec.ts`) and `e2e/ship/*.spec.ts`. No baseline file changes; a helper change it needs goes to W2. | batch B files | W2's first PR (support layer and helpers) merged |
| W4 | sonnet-worker (Sonnet 5.5, medium) | C8: `DemoControls`, the two client entry files and `ClientEntry`, the HTTP stub, the "Not connected yet" screen, `store.ts` off the mock, the clock seam (the demo clock into `demo-clock.ts`, every other reader on `ClientEntry.now()`), the dev switcher, `?demo`, Reset demo and the tour reading `demo`; the product build check script with its three parts. Starts after W1, so its edits to files W1 also touched are sequential. | `src/agent/index.ts`, `src/agent/client.demo.ts`, `src/agent/client.product.ts`, `src/agent/client-entry.ts`, `src/agent/demo-controls.ts`, `src/agent/demo-clock.ts`, `src/agent/http/**`, `src/state/store.ts`, `src/shell/**`, the demo-reading and clock-reading call sites in `src/App.tsx`, `src/ErrorBoundary.tsx`, `src/overlays/{CommandPalette,Menus,ProblemPanel}.tsx`, `src/screens/{Settings,Tools,Chats,Usage}.tsx`, `src/screens/settings/content.ts`, `src/state/derive.ts`, `src/components/Composer.tsx`, `scripts/check-product-build.mjs`; `src/agent/mock.ts` and `src/agent/clock.ts` only for the `DemoControls` and clock moves | W1's second PR merged (shared files above) |
| W5 | sonnet-worker (Sonnet 5.5, medium) | The contract suite on the mock: targets list, schema parse of every `read()` value, every `RunEvent` from `ask()` and every write result; stable snapshot identity between changes; notices; optimistic rollback on a forced failure (the Cap reached scenario and an injected `AgentError`). It needs only the schema to start, and wires its reset to `demo.reset()` once W4 merges. | `src/agent/contract/**` | W1's first PR merged; W4 for the final wiring |

Sensitive pieces: none in P1 (no auth, money movement, schema migration or concurrency). W1 is Opus because it's a
wide typed refactor where a missed field shows only in a screenshot.

## Orchestrator only

- PR0: `app/package.json` and `app/package-lock.json` (zod, the `build:product` script), `app/shared/contract/index.ts`
  (the barrel; workers add files, the orchestrator adds their exports), `tsconfig.app.json` (include `shared/`, the
  `@client` path) and `tsconfig.worker.json` (include `shared/`), `vite.config.ts` (the `@client` alias by mode, the
  product output folder, the module list for the build check, the demo-only public copy), `vitest.config.ts` (the
  `@client` alias, and include `src/**/*.test.ts` so the contract and formatter tests run beside the property tests),
  `playwright.config.ts` (a `product` project that serves the product build on its own port and base URL and runs
  only `e2e/product/*.spec.ts`; every other project ignores `e2e/product/`), the move of `public/library/` and
  `public/avatars/` to `app/public-demo/`, and the stored-demo fixture `e2e/support/fixtures/demo-storage-pre-seam.json`
  captured from `main`'s build.
- `.github/workflows/ci.yml`: the step that runs `build:product` and the product build check. It lands as the
  orchestrator's commit on W4's PR, so the check and its required run arrive together. No placeholder step.
- `e2e/product/no-demo.spec.ts` (after W4: the product build shows no sample name, no demo switches, ignores `?demo`,
  runs on today's date and shows the "Not connected yet" screen).
- `e2e/demo-upgrade.spec.ts` (after W1 and W4: the stored-demo fixture loads through `fx.seedRaw` with its chat,
  draft, model pick and approval state intact).
- `app/package.json`'s `lint:tokens` line gains `check-format.mjs` when W1 lands it.
- `AGENTS.md` (layout: `shared/`, `src/agent/http/`, `e2e/support/`, `public-demo/`; commands: `build:product`),
  `app/README.md`, `.agents/skills/verify/feature-map.md` and `SKILL.md`, this plan's status.
- `e2e/ship/agent-seam.spec.ts` (the ship spec below).
- Integration: merging worker PRs, resolving any conflict in a shared file, the final PR.

## Order and parallelism

1. PR0 (orchestrator): dependencies, configs, empty `shared/contract/`, the public-file move, the stored-demo fixture.
2. In parallel: W1's first PR (schema, inventory, golden file) and W2 (support layer, then batch A).
3. When W2's support PR merges: W3 (batch B). When W1's first PR merges: W5, while W1 carries on with C1.
4. When W1's second PR merges: W4 (C8 and the clock seam).
5. When W4 merges (with the CI step): W5 switches its mock target to `demo.reset()`; the orchestrator writes
   `e2e/product/`, the upgrade spec and the ship spec.
6. Final PR. At most 4 workers run at once (W1, W2, W3 and W5; then W4 and W5).

## Browser scenarios (`e2e/ship/agent-seam.spec.ts`, desktop 1440x900 and phone 390x844, on the demo preview)

- S1: Today opens at 8:00 AM on Mon, Nov 16 with the morning check, the same six things and the same dollar amounts as
  before.
- S2: A suggested question streams its answer with the orders table; times and amounts read as before.
- S3: In Act, approving a fix shows the hold, Undo stops it, and Activity shows the stamped time on the demo clock.
- S4: Usage shows this month's spend and the per-tool dollars as before.
- S5: The demo switches move to Run and to Cap reached; Reset demo returns to the 8:00 AM start.
- S6: Library and All chats show their dates ("Nov 16", "Yesterday") as before, and the Library's sample files open.

## Acceptance

1. The visual suite (`visual-desktop`, `visual-phone`) passes with no baseline file changed.
2. Every existing E2E project passes in CI with no assertion removed or loosened; the PR body lists every edited spec
   with the reason (C10).
3. Every instant in the contract is `{ iso, ms }`, every amount `{ minor, currency }`, every schedule time
   `{ hour, minute }`; no screen formats a time or amount outside `src/lib/format.ts`.
4. The differential test shows the new formatter's output equal to the golden file of old display strings for every
   sample value; a property test shows `format` gives the same text from `iso` and from `ms` for the same instant, and
   the right local time for one instant in two zones; `npm run lint` fails on a locale formatting call outside
   `format.ts`.
5. Every type the `AgentClient` returns is inferred from a schema in `app/shared/contract/`; no hand-written duplicate
   remains in `types.ts`.
6. The contract suite passes on the mock: every `read()` value, every run event and every write result parses; a
   snapshot keeps its identity until a change; a forced failure rolls the optimistic write back and raises a notice.
7. `AgentClient` has no `setDemo`, `reset` or scenario member; `DemoControls` holds them; `store.ts` imports nothing
   from `src/agent/mock*`; nothing outside the demo entry and the mock imports the demo clock.
8. `npm run build:product` succeeds. The product build check passes on it (canaries, module graph, copied files) and
   fails on the demo build, proving each part; CI runs both, and the check landed in the same PR as its CI step.
9. The `product` Playwright project passes on its own URL: no sample name, no demo switches, `?demo` ignored, today's
   date, the "Not connected yet" screen. No other project runs `e2e/product/`.
10. `npm run lint` fails on an `inhouse.demo.` storage key or a sample-data import in a spec outside `e2e/support/`;
    none remain.
11. The upgrade spec passes: a demo stored by the build before P1 opens with its chat, draft, model pick and approval
    state intact.
12. Initial JS stays under hardening's bundle budget for the demo build.
13. The ship recording shows S1 to S6 on desktop and phone with QA PASS, and the merged demo deploys unchanged.

## Must not

No visual change and no baseline update; no assertion removed or loosened to make a spec pass; no runtime switch that
leaves the mock reachable in the product build; no demo clock or sample file in the product build; no backend, route
or Worker change; no change to the demo's storage keys (a returning visitor keeps their demo); no CI step that passes
before its checker exists; no retries or fixed waits; no deploy of the product build.

## Risks

- **C1 is wide.** About 40 fields across 20 sample files and most screens. A missed field shows only as a changed
  screenshot. The field inventory, the differential test and the visual suite catch it; W1 is Opus for this reason.
- **Relative dates.** "Yesterday" and "2 days ago" depend on the demo clock; the formatter takes "now" as an argument
  so tests pin it.
- **Stored demos.** A stored value in the old shape could break a returning visitor's demo; the upgrade spec covers
  it, and the mock converts an old shape on load.
- **Spec churn.** 54 spec files touch storage today and hardening just edited all of them; W2 and W3 start from merged
  hardening only.
- **Vite plugin output.** A second build mode may clash with the Cloudflare plugin's single Worker output; the
  orchestrator checks its docs at PR0 and falls back to a separate config file for product mode.
- **Bundle budget.** zod must stay type-only in the demo build; the budget check catches a runtime import.

## How it lands

- Branch `fleet/agent-seam` from `main` after hardening merges. Worker PRs into it with merge commits once `ci` and
  review are clean.
- Review rows (change-loop): W1 and W4 Sonnet plus Opus at medium (multi-file refactor); W2, W3 and W5 Sonnet plus
  Opus at medium (test infrastructure and changed existing checks, listed in the PR body); PR0 Sonnet alone at medium
  plus the changed-checks list (config and CI). The final PR gets Sonnet plus Opus at high on the whole branch.
- Final PR into `main`: full CI, previews, visual QA of changed screenshots (expected none), the QA gate on S1 to S6,
  the ship recording, Wasim's approval of the head SHA, squash merge with `--match-head-commit` and a `Verified:`
  trailer. After merge, hardening's deploy pipeline deploys the demo; its smoke and the ship specs against production
  confirm it's unchanged.
