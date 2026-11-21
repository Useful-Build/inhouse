# Agent guide

Rules for coding agents working in this repo. Read `app/README.md` for how the app works before you change it.

## Layout

- `app/` is the whole app: a React single-page app served by a Cloudflare Worker. The demo's Worker is `app/worker/`
  (assets plus the client-error route); the product's is `app/server/` (P2 and P3, below).
- `app/src/agent/` holds the `AgentClient` interface, the mock agent and its sample data (`sample-data/`, invented). The
  two client entries (`client.demo.ts`, `client.product.ts`) pick the client at build time; `src/agent/http/` is the
  product's real client (`HttpAgent`: chats, the turn socket, usage, memory, models, settings).
- `app/shared/` holds the zod schemas for everything the `AgentClient` returns (`shared/contract/`); `src/agent/types.ts`
  re-exports their types.
- `app/server/` is the product Worker (P2 and P3, below; the chat code is `server/do/brand-agent/`, `server/do/runner/`,
  `server/egress/` and `server/mcp/`), `app/runner/` the container image's runner (its own `package.json`: `npm test`,
  `npm run typecheck`, `npm run check:zod`, with `harness/` for the S6 check and `image/` for the probes),
  `app/test/scripted-model/` the scripted model (test builds only), `app/evals/` the eval harness, `app/ops/` the table registry (`ops/tables/`: every D1 table, Durable
  Object store and R2 prefix, registered in the PR that adds it).
- `app/build-support/` holds the build helpers and their tests (the demo deploy redirect).
- `app/public-demo/` holds the demo-only public files (the Library's sample files, avatars); the product build ships none.
- `app/src/ui/` holds the app's own components, `app/src/components/ui/` the base's shadcn components.
- `app/e2e/` holds the Playwright specs and the visual baselines; `app/e2e/ship/` the ship recording specs;
  `app/e2e/support/` the fixtures layer (`fx`: sample names and seeding, the only place that knows the mock's storage
  keys); `app/e2e/product/` the product build's specs.
- `docs/plans/` holds the approved plans. `.github/rulesets/` holds the branch rulesets as applied.
- `docs/adopted-libraries.md` is the register of adopted base libraries and the procedure for updating them.

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
| `npm run test:unit` | Light job (no server: `server/` tests run workerd in-process). Vitest: `src/**/*.test.ts` (property tests included), `build-support/` and the rest in node; `server/**/*.test.ts` in the Workers runtime with a migrated local D1 (`@cloudflare/vitest-plugin`) |
| `npm run build` | Type check and production build (the demo build) |
| `npm run build:product` | The product build into `dist-product/`: no mock, sample data, demo controls or demo clock. `node scripts/check-product-build.mjs` checks it (CI runs both) |
| `npm run build:product-test` | The test build into `dist-product-test/`: the product Worker with the test issuer compiled in and `wrangler.test.jsonc`. Never deployed |
| `npm run build:product-eval` | The eval build into `dist-product-eval/`: the test issuer and the eval trace (`@eval-trace`) compiled in, the real model through the gateway (no scripted model), `wrangler.eval.jsonc`. Deployed only to the sandbox, from main, by the ops repo. `check-product-build.mjs` needs it beside the other two |
| `npm run test-build:migrate` | Apply `server/migrations/` to the test build's local D1 (`.wrangler/test-build`, or `-- --persist-to <dir>`) |
| `npm run test-build:seed` | Seed that D1 with the invented brand (`server/seed/run.ts`; refuses an unmigrated D1 and fails loud if the seed is missing; same `-- --persist-to <dir>`) |
| `E2E_TEST_BUILD=1 npx playwright test --project=api --project=real-desktop --project=real-phone` | The test build's specs (`e2e/api/`, `e2e/real/`), after `npm run build:product-test`. No other run includes them |
| `cd runner && npm test` | The runner's unit tests (light job; `npm run typecheck` and `npm run check:zod` beside it). CI's `runner` job also builds the image and runs the container probes |
| `node evals/run.ts --target fake --out <dir>` | The eval harness dry run (no model, no cost). `--target product` needs `--paid` and `--budget`, and Wasim's OK to run |
| `E2E_TEST_BUILD=1 npx playwright test --project=smoke` | The release smoke (`e2e/smoke/`, read only) on the test build. On a release: `SMOKE_BASE_URL=<url> npx playwright test --project=smoke`, with the service-token env vars in the `verify` skill |
| `npm run preview` | Build, then serve the build |
| `npm run test:e2e` | Every Playwright project against the production build (macOS skips the visual ones) |
| `npm run test:visual:linux` | The visual suite in the Playwright Docker image (`:update` regenerates baselines) |
| `E2E_PRODUCT=1 E2E_PREBUILT=1 npx playwright test --project=product` | The product build's specs (`e2e/product/`), after `npm run build:product`. No other run includes them |
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
  `fleet/**`, with no bypass. `ci` runs on every PR into either. Into `main` it runs everything (typecheck, lint,
  unit, build, every Playwright project, the test build, the runner image and its probes). Into a `fleet/**` branch
  (phase batching, Wasim, 2026-11-21) it runs only the fast checks: typecheck, lint, unit, the builds and their guards,
  the fresh-install migrations, and the runner's tests without the image. The whole suite then runs on each push to
  `fleet/**` (every merge), and a newer merge cancels the run in progress, so an e2e break shows up there a few
  merges late, not on its own PR. Watch the branch's `ci` runs after merging into it. Never retarget a PR from
  `fleet/**` to `main`: its fast-path `ci` stays green and `ci` doesn't re-run on a base change. Open a new PR, or
  push a commit after retargeting so the main path runs. Before merging anything into `main`, check that
  `e2e (1/2)`, `e2e (2/2)` and `test-build` show pass, not skipped. `pr-gates` fails a commit without a `Verified:`
  trailer and flags changed existing checks. `main` also needs the branch up to date with `main`. No merge queue for
  now.
- **Commit hook:** `.githooks/commit-msg` refuses a commit whose `Verified:` trailer `git interpret-trailers --parse`
  can't print (merge commits pass). `npm install` in `app/` runs `prepare`, which sets `core.hooksPath` to `.githooks`
  (the hooks run the global hook of the same name and the repo's own `.git/hooks` one after their own check, via
  `.githooks/chain.sh`, so a global hooks path keeps working).
- **Big projects:** one integration branch `fleet/<topic>` cut from `main`. Each piece is its own PR into it, merged
  with a merge commit. Bring `main` into it through a PR (direct pushes are blocked). The final PR into `main` gets
  full CI, reviews, a preview, the QA gate and a ship recording (`ship.yml`, run by hand with the PR number and its
  ship spec; `-f build=test` for a backend phase from P2 on, which records on the test build instead of a preview). Wasim approves that head SHA, then it squash-merges with `--match-head-commit <sha>` and a squash
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
- **CI rounds (Wasim, 2026-11-20).** For CI, a round is one fix push or one re-run, counted per check: a new error
  on the same check is still a round, escalation rounds included, and a check that first goes red after a push starts
  its own count. A worker fixing its own CI stops and reports back once a check it's fixing is still red after two
  rounds; the orchestrator then escalates as above. A change to the CI environment (host settings, sysctls, runner
  config) is never a worker's fix: the worker proposes it in its report, the orchestrator decides with the PR's
  review, and one that costs money goes to Wasim. The orchestrator may give a spike brief a larger budget (for
  example 4 rounds); once it's spent the worker reports back and the escalation above runs from there.
- **The connector hub (P4):** `app/hub/` is its own package (own `package.json`, lockfile, `tsconfig.json` and
  `vitest.config.ts`; `tsc -b` in `app/` doesn't check it). Config template `app/wrangler.hub.jsonc` (no account ids,
  hosts or shop handles), test config `app/wrangler.hub.test.jsonc`. Connectors live in
  `app/hub/connectors/<tool>/route.ts`, each listed in `app/hub/connectors/index.ts` (one orchestrator line per
  connector). Checks, in `app/hub/`: `npm ci`, `npm run typecheck`, `npm run test:node` (a worker's seat);
  `npm run test:workers`, `npm run bundle` and `npm run bundle:test` start workerd or bundle, so they run in CI or
  under the heavy lock. Two scans, in `app/`: `node scripts/check-hub-build.mjs` (the deployable bundle carries no test
  seam and the test bundle is caught) and `node scripts/check-hub-config.mjs <config>` (no public route, no test build,
  no secret in `vars`; the template passes, the test config must fail). The `hub` job in `ci.yml` runs all of it, and
  `ci` needs it. **Outside-`app/hub/` rule:** code bundled into the hub from outside `app/hub/` (the recorded upstreams
  in `app/test/upstreams/`) imports no npm package: the `hub` job installs only `app/hub/node_modules`.
- **Hub key rotation** (`HUB_TOKEN_KEYS`, from #95):
  1. Add the new key to `keys` in `HUB_TOKEN_KEYS`, `current` unchanged. `wrangler secret put HUB_TOKEN_KEYS` through
     a secret card (this deploys a version).
  2. Set `current` to the new kid; put again. New seals use it; old envelopes still open.
  3. Wait for the refreshes (every Shopify refresh, about every 12 h, seals under `current`; reads also re-seal
     lazily), or call `ServerGateway.reencrypt(scope, accountId)` for each account (P5 and later; the product Worker
     knows its accounts).
  4. When `ServerGateway.status` shows the new `kid` for every account, remove the old key; put again.

  Removing a key still in use makes that record `key_unavailable`: a client credentials account discards it and grants
  again (log `signin_key_missing`); an OAuth account (P5) needs a reconnect.
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
  scripts), `app/wrangler.jsonc`, `app/worker/`, `app/public/_headers`, `app/server/auth/**` (auth), `app/server/migrations/` (the D1
  schema), `app/wrangler.product.jsonc` and `app/wrangler.test.jsonc` (Worker config), `app/ops/` (ops), `app/hub/{signin,crypto,scope,testing}/` (P4, not built yet: the hub's sign-in, key handling, scopes and
  test seam), `app/wrangler.hub.jsonc` and `app/wrangler.hub.test.jsonc` (P4, not built yet: hub Worker config) and the `check-hub-*`
  scripts in `app/scripts/` (`check-hub-build.mjs`, `check-hub-config.mjs` and their fixtures).
- **The product Worker (P2).** `app/server/` is the product Worker (entry `server/index.ts`): every `/api/*` request is
  authenticated (Access JWT), then the `Origin` check, the route (`server/routes.ts`), its row in
  `server/access-matrix.ts` and `checkAccess`, then the handler; every answer carries the security headers
  (`shared/security-headers.ts`, from `public/_headers`). Layout: `server/auth/` (sign-in, principals, the test
  issuer), `server/db/` (the D1 data layer), `server/api/` (handlers), `server/migrations/`, `server/seed/`,
  `server/ops/` (health and its signals), `app/ops/tables/` (the table registry). `routes.ts`, `access-matrix.ts`, the
  registries' `index.ts` files, `app/wrangler.*.jsonc`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`
  and the workflows are the orchestrator's. Configs: `app/wrangler.product.jsonc` is a template with no account id,
  host, `aud`, client id or brand name (the private ops repo fills them at release); `app/wrangler.test.jsonc` is the
  test build's, made-up values only, and never deploys. `scripts/check-product-config.mjs` (W1) exits 0 for a
  deployable config, 1 when it refuses one and 2 on usage or a crash; CI requires exactly 1 on `wrangler.test.jsonc`.
- **The test issuer stays out of the product build:** import it only as `@test-issuer`, never by its path. Only
  `vite build --mode product-test` and `--mode product-eval` resolve that to `server/auth/test-issuer.ts`; every other
  build gets `server/auth/issuer-off.ts` (same exports, trusting nothing), and `check-product-build.mjs` fails the
  deployable build on any `test-issuer` module or the canary.
- **The eval trace stays in the eval build:** import it only as `@eval-trace`. Only `vite build --mode product-eval`
  resolves that to `server/eval-trace/on.ts`; every other build, the test build included, gets
  `server/eval-trace/off.ts`, and `check-product-build.mjs` fails the product and test builds on its module or canary
  and the eval build without them. The eval build never compiles the scripted model, so its egress always takes the
  gateway (`__INHOUSE_EVAL_BUILD__`).
- **The test build** is the proof path for the backend: `npm run build:product-test`, then the `api` and `real`
  Playwright projects with `E2E_TEST_BUILD=1` (the `verify` skill has the details). It runs the product Worker under
  `wrangler dev` with a fresh local D1 and a test issuer whose key pair is made per run; only the public half reaches
  the Worker, and only a build compiled with the test flag trusts it. CI's `test-build` job runs it on every PR into
  `main` and on each push to `fleet/**` (not on a PR into `fleet/**`: phase batching), with no secret.
- **Migrations:** `app/server/migrations/`, forward-only (never rename or drop in the release that stops using it).
  Ranges per phase: P2 `0001`-`0099`, then a block of 100 each (P3 `0100`-`0199` up to P8 `0600`-`0699`); the
  orchestrator gives each worker its numbers in landing order. Wrangler applies every file not yet in `d1_migrations` in file-name order, so a lower number
  merged after a higher one still applies (checked 2026-11-20 with wrangler 4.162.0). CI's `test-build` job applies
  them all to an empty D1 (the migration job's fresh install), and on a PR into `fleet/**` the `fast` job does; from
  P3 it also upgrades from the last release tag.
- **Candidate deploys** go to the separate sandbox Cloudflare account only, with invented data, before a phase's final
  PR. Nothing from a `fleet/` branch deploys to the house or a brand account; releases come from tags on `main`.
- **Shared ports:** dev 5173, E2E preview 5193 (`E2E_PORT`), the product build's E2E server 5194 (`E2E_PRODUCT_PORT`), the test build 8787 (`E2E_TEST_BUILD_PORT`; the `ship` workflow serves it there too). Give each parallel worktree its own `E2E_PORT`, `E2E_PRODUCT_PORT` and `E2E_TEST_BUILD_PORT`.
- **Fleet repo:** no. `fleet/<topic>` is only the integration branch name here.
- **Test build, projects and migrations (P2).** The test build (`npm run build:product-test`, `wrangler.test.jsonc`) is
  the product Worker with the test issuer compiled in, served by `wrangler dev` on a local D1 and R2; it proves every
  backend PR and never deploys. Its Playwright projects: `api` (`e2e/api/`, every route against every role), `real-*`
  (`e2e/real/`, a browser with the CSP guard) and `smoke` (`e2e/smoke/`, the read-only release smoke). Migrations live in
  `server/migrations/`: P2 `0001`-`0099`, then a block of 100 per phase (P3 `0100`-`0199` up to P8 `0600`-`0699`), as the
  backend plan's "Migrations" says; forward-only.
- **Accounts and releases (P2).** The sandbox Cloudflare account is for candidate deploys only (the ops workflow
  rehearsed with invented data); there is no per-PR product preview (decision Q1). Since P3 a per-PR deploy of the test build with the runner container
  goes to the sandbox account (`inhouse-sbx-pr<N>` names, guarded by `scripts/sandbox/names.mjs`), is drained and warmed up
  (route 48), and the chat specs run against it with `E2E_TEST_BUILD_REMOTE=1` (decision Q2: the local sandbox can't run
  Bash, so chats are proved there). The test build is still the per-PR proof for everything else.
  The release (create D1 and R2, fill the config template, migrate, set secrets, deploy a tag, run the smoke) runs from
  the private ops repo, never from this one. Keep account ids, hostnames and team domains out of this repo.
