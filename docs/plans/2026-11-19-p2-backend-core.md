# P2: backend core (`fleet/backend-core`)

Status: draft, 2026-11-19. Phase plan under the backend plan (`docs/plans/2026-11-19-backend.md`). Common rules are in
its "Phase schedule (waves)" section.

## Goal

Stand up the product Worker with sign-in, members, roles, settings and the audit log, backed by D1, proven on per-PR
previews in the sandbox account and released from one tag to the house account and a second account.

**Success measure (the real slice):** sign in, see your own name and role, change a setting, reload, it's there, the
audit log shows it; a second account deploys from the same release.

## Scope

In:
- The product Worker (`app/server/`), serving the product build and `/api/*`.
- Access JWT verification against a configured issuer and audience, failing closed; a test issuer for local runs,
  tests and previews; service-token principals (QA gate, monitoring) mapped to named principals with their own routes.
- D1 schema and forward-only migrations: members (keyed by the identity provider's stable subject), roles, settings,
  the audit log (append-only, SQL triggers reject update and delete).
- Object-level permission checks (whose record, which role, an unexpired support grant), and support grants (BD7) with
  their audit lines.
- **C2** `me()` (member id, name, role, `can`), actor ids on records, approvers as member ids, stage from the server.
- **C3** per-resource `status` with `error` and `retry()`; codes `unauthorized`, `not_found`, `rate_limited`,
  `cap_reached`; long lists page.
- **C6** `rev` on editable records, `ifRev` on writes, `conflict` returns the current record.
- **C9** settings typed per key; the profile photo uploads to R2 (downloads through the Worker with a permission
  check).
- The audit log page and its CSV export.
- The real client (`src/agent/http/`) for these methods, parsing at the boundary through the shared schema.
- Per-PR product previews in the sandbox account: a D1 per PR (create, migrate, seed the invented brand, bind, delete),
  one sandbox R2 bucket with a per-PR prefix, behind Access with a service token for the QA gate.
- API specs (Playwright `request`) and the contract suite on the real client for these methods.
- A release tag deployed to the house account and a second account.
- Retests from P0 S3: containers in Previews, and Access with a service token.

Out: runs, chats, the runner and WebSockets (P3); connectors (P4, P5); approvals (P6); retention, export and backups
(P8, which builds on this schema).

## Inputs and gates

- P1 merged into `main` (shared schema folder, product build, fixtures layer, contract suite).
- **From Wasim before the previews piece:** the separate sandbox Cloudflare account, a scoped API token for it (secret
  card), an Access team there with a test identity provider or one-time PIN, and a second account for the release
  test. Before the release piece: his OK for that release to the house and second accounts.
- No paid tier without Wasim's OK (Access stays on the free plan; D1 and R2 within Workers Paid).

## Design notes

- **Layout.** `app/server/` is the product Worker (entry `app/server/index.ts`), separate from the demo Worker in
  `app/worker/`, which stays assets plus hardening's client-error route. Product config is a template,
  `app/wrangler.product.jsonc`, with no account id, host or brand name; CI and the private ops repo fill per-account
  values. The orchestrator confirms at PR0 how the Cloudflare Vite plugin takes a second config in product mode.
- **Routes** are registered in one table, `app/server/routes.ts` (orchestrator only); each worker's module exports its
  handlers. Every handler receives a verified principal; there is no unauthenticated handler except the health route
  (P8) behind its own service token.
- **Migrations** live in `app/server/migrations/` and are numbered per phase range so parallel phases can't collide:
  P2 `0001`-`0099`, P3 `0100`-, P4 `0200`-, P5 `0300`-, P6 `0400`-, P7 `0500`-, P8 `0600`-. The orchestrator confirms
  in the D1 docs at PR0 that `wrangler d1 migrations apply` applies an unapplied lower number after a higher one;
  if it doesn't, waves serialize migrations through the orchestrator instead.
- **Schema files.** Each worker owns `app/shared/contract/<resource>.ts` for its resource; the barrel `index.ts` is
  orchestrator only.
- **Mock first.** C2, C3, C6 and C9 land on the mock and the UI before the real client relies on them, with the visual
  suite unchanged in the demo.
- **The test issuer** signs JWTs with a key generated per test run; the Worker trusts it only when a build-time flag
  says test or preview, and a deploy check fails a product config that trusts any issuer but the account's Access
  team. Previews sit behind the sandbox's Access too; the test issuer is for `wrangler dev` and CI only.
- **Seed.** `app/server/seed/` writes the invented brand (members with each role, two Members with the same role,
  settings, a few audit lines) through the same data layer, never raw SQL that skips the audit log.

## Workers

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| W1 | opus-worker (Opus 5.5, medium), sensitive: auth | Access verification (JWKS fetch and cache, issuer and audience, fail closed, WebSocket upgrade helper for P3), the test issuer, subject-to-member mapping, roles and `can`, the object-check helper, service-token principals, support grants, the deploy check for the issuer. Opus writes the design into the brief. | `app/server/auth/**`, `app/shared/contract/me.ts`, `app/scripts/check-product-config.mjs` | PR0 |
| W2 | opus-worker (Opus 5.5, medium), sensitive: data | The D1 data layer and handlers: members, typed settings (C9), `rev` and `ifRev` with `conflict` (C6), the audit writer with field redaction, the audit page query and CSV export, the photo upload and permission-checked download on R2, paging for long lists. Writes the migration SQL as a proposal in its PR; the orchestrator commits it. | `app/server/db/**`, `app/server/api/{members,settings,audit,photo}.ts`, `app/server/seed/**`, `app/shared/contract/{settings,audit,members}.ts` | PR0, W1's principal type |
| W3 | sonnet-worker (Sonnet 5.5, medium) | C2, C3, C6 and C9 on the mock and the UI: `me()` in the account menu and Settings, actor names from ids, approvers as member ids in approval rules, per-resource error and retry states, the conflict notice with the current value, typed settings, photo upload through `setPhoto`. Demo looks unchanged. | `src/agent/mock.ts`, `src/agent/demo-controls.ts`, `src/screens/settings/**`, `src/screens/Settings.tsx`, `src/overlays/Menus.tsx`, `src/overlays/TeamWindow.tsx`, `src/ui/photo.ts`, the error and retry pieces in `src/ui/**` | PR0 |
| W4 | sonnet-worker (Sonnet 5.5, medium) | The real client for these methods (fetch, schema parse both ways, error codes, `retry()`, `ifRev`), the contract suite's real target under `wrangler dev` with a seeded D1 and the test issuer, and `e2e/support/clients/real.ts`. | `src/agent/http/**`, `src/agent/contract/targets/real.ts`, `app/e2e/support/clients/real.ts` | W1, W2 handlers merged; W3's mock shape |
| W5 | opus-worker (Opus 5.5, medium), sensitive: env and secrets | Product previews in the sandbox account, as a bootstrap PR into `main` (workflow files run from `main`): per-PR config generation, D1 create, migrate, seed and delete, the R2 prefix, Access with the QA service token, cleanup of leftover container apps; the P0 S3 retests (containers in Previews, Access service token) written up in `docs/decisions/p2-previews-retest.md`. | `.github/workflows/preview.yml`, `.github/workflows/preview-cleanup.yml`, `app/scripts/preview-config.mjs` | PR0; Wasim's sandbox account and token |
| W6 | sonnet-worker (Sonnet 5.5, medium) | API specs: 401 without or with a bad JWT on every route; every route and object against every role, including two Members (one can't read the other's personal settings); support grant expiry; revisions and conflict; paging. A route-list test fails when a route is added without a spec row. | `app/e2e/api/**` | W1, W2 merged |

## Orchestrator only

- PR0: `app/package.json` and lockfile (`jose` or WebCrypto only, checked against Cloudflare's JWT docs), the
  `app/server/` skeleton, `app/server/routes.ts`, `app/wrangler.product.jsonc`, `app/tsconfig.server.json`,
  `vite.config.ts` and `playwright.config.ts` (an `api` project and a `real` project), `app/shared/contract/index.ts`.
- `app/server/migrations/**` (from W2's proposal; Sonnet plus Opus at high review).
- `.github/workflows/ci.yml` (run the `api` project and the contract suite's real target under `wrangler dev`).
- The release: a `release` tag, deploys to the house and second accounts with the private ops repo's workflow
  (Wrangler only, per BD13), and the rollback rehearsal (redeploy the previous tag). Account details stay in the ops
  repo.
- `AGENTS.md` ("How changes land here": product previews, the sandbox account, `server/` layout, migration ranges),
  the `verify` skill and feature map, `e2e/ship/backend-core.spec.ts`.

## Order and parallelism

1. PR0 (orchestrator). In parallel, W5's bootstrap PR into `main` once Wasim's sandbox account exists (it can't wait
   for the phase's final PR: workflow files run from `main`).
2. W1, W2 (from W1's principal type, shared early as a small first commit) and W3 in parallel.
3. Migrations committed by the orchestrator from W2's proposal as soon as they're reviewed.
4. W4 and W6 when W1 and W2 merge.
5. Release to the house and second account from the branch head once the API specs pass; rollback rehearsed.
6. Final PR. At most 4 workers at once (W1, W2, W3, W5), then 2 (W4, W6).

## Browser scenarios (`e2e/ship/backend-core.spec.ts`, desktop and phone, on the product preview with the QA service token mapped to a seeded Admin)

- S1: Open the app and see your own name and role in the account menu.
- S2: Change the time zone in Settings, reload, and it's still set.
- S3: The audit log shows that change with your name and the time; Export CSV downloads it.
- S4: Upload a profile photo, reload, and it shows in your avatar.
- S5: As a Member (a second service token), the team pages are read-only and an admin-only action isn't offered.
- S6: Two tabs edit the same setting; the second save shows a conflict with the current value.
- S7: The demo preview is unchanged (S1 of P1's ship spec, re-run).

## Acceptance

1. Every `/api/*` route returns 401 without a valid Access JWT, and with a JWT from another issuer or audience.
2. The role and object spec passes for every route, every role and two Members with the same role.
3. The product config check fails a config that trusts any issuer but the account's Access team, and a product config
   with a `workers.dev` or preview hostname for a brand deployment.
4. A setting saved with a stale `ifRev` gets `conflict` and the current record; the UI shows it.
5. Every write and every person's action writes one audit line with redacted arguments; SQL triggers reject an update
   or delete on the audit table (tested); the CSV matches the table.
6. A photo uploads to R2 and downloads only through the Worker for a member allowed to see it.
7. The contract suite passes on the mock and the real client for the P2 methods; every value parses through the
   shared schema.
8. Each PR gets a product preview with its own D1, seeded; closing the PR deletes the D1, the R2 prefix and any
   container app; a preview's D1 holds only its own data.
9. The P0 S3 retests have a decision record: containers in Previews (pass or still failing) and Access with a service
   token (pass or fail), and the plan is updated if the result changes P3.
10. One release tag deploys to the house account and a second account; a rollback is a redeploy of the previous tag,
    rehearsed once.
11. The demo build and its visual suite are unchanged.
12. QA PASS and the ship recording on S1 to S7.

## Must not

No permission checked only in the UI; no route without a principal; no secret in the repo, a log or a job that runs PR
code; no account id, hostname or brand name in this repo; no real data in a preview; no update or delete path on the
audit log; no migration that renames or drops in the same release that stops using it; no release to an account
without Wasim's OK; no retries in tests.

## Risks

- Access in front of previews is unverified (P0 S3). If service tokens can't pass a preview's Access, the QA gate runs
  on `wrangler dev` with the test issuer and on the house deployment, and Wasim is told.
- Containers in Previews failed in P0; the retest decides whether P3's E2E can use previews.
- Per-PR D1 creation can leak databases if cleanup fails; the daily cleanup lists and deletes by prefix, and a count
  alert lives in the ops monitor (P8).
- Two parallel phases adding migrations: the ranges and the docs check above.
- JWKS fetch failures: cache with a short TTL and fail closed; never fall back to accepting an unverified token.

## How it lands

- Branch `fleet/backend-core` from `main` after P1 merges. W5's workflows land first as a bootstrap PR into `main`
  (Sonnet plus Opus at high: secrets and env), then `main` merges into the branch.
- Review rows: W1, W2, W5 and the migrations at Sonnet plus Opus high (auth, schema, secrets); W3, W4, W6 Sonnet plus
  Opus medium.
- Final PR into `main` with the full ship gate. After merge: the demo deploys through hardening's pipeline; the
  product release to the house deployment is the orchestrator's step with Wasim's OK, then the ship specs run against
  the house deployment as a smoke.
