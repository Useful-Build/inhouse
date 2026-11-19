# P2: backend core (`fleet/backend-core`)

Status: draft, 2026-11-19, revised after the Sonnet and Opus review. Phase plan under the backend plan
(`docs/plans/2026-11-19-backend.md`). Common rules are in its "Phase schedule (waves)" section.

## Goal

Stand up the product Worker with sign-in, members, roles, settings and the audit log, backed by D1, proven on per-PR
previews in the sandbox account and released from one tag to the house account and a second account.

**Success measure (the real slice):** sign in, see your own name and role, change a setting, reload, it's there, the
audit log shows it; a second account deploys from the same release.

## Scope

In:
- The product Worker (`app/server/`), serving the product build and `/api/*`.
- Access JWT verification against configured issuers and audiences, failing closed. One audience per Access
  application: the brand team's application gives Member or Admin from D1; the Inhouse team's separate application,
  pinned to our identity provider, gives the Inhouse team role (an email row alone never does). A test issuer for
  `wrangler dev` and CI only. Service-token principals (QA gate, monitoring) mapped to named principals with their own
  routes.
- D1 schema and forward-only migrations: members (keyed by the identity provider's stable subject), roles, settings,
  support grants, the audit log (append-only, SQL triggers reject update and delete).
- **The access matrix:** a committed table of route by role by ownership, and a scope for every settings key
  (personal, brand or technical). Technical pages belong to the Inhouse team and are read-only for admins (decision
  log, "Roles" and "Roles: admin views"); the one admin exception is switching a model off. Object checks (whose
  record, which role, an unexpired support grant) read from it.
- **Support grants** (BD7): an admin grants the Inhouse team time-boxed access; the grant, its use and its end are
  audited; ending it closes access at once.
- **C2** `me()` (member id, name, role, `can`), actor ids on records, approvers as member ids, stage from the server.
- **C3** per-resource `status` with `error` and `retry()`; codes `unauthorized`, `not_found`, `rate_limited`,
  `cap_reached`; long lists page.
- **C6** `rev` on editable records, `ifRev` on writes, `conflict` returns the current record.
- **C9** settings typed per key; the profile photo uploads to R2 (downloads through the Worker with a permission
  check).
- **Contract-wide, real where it lives in P2.** C2, C3 and C6 land in the shared schema and on the mock for every record
  in the contract (routines, rules, memory, approvals, activity, files). Real handlers in P2 are members, settings,
  grants, the audit log and the photo; the rest stay `unavailable` until their phase.
- The audit log page and its CSV export.
- The real client (`src/agent/http/`) for these methods, parsing at the boundary through the shared schema.
- Per-PR previews in the sandbox account: every PR keeps its demo preview and, once `app/wrangler.product.jsonc`
  exists on the branch, also gets a product preview with its own D1 (create, migrate, seed the invented brand, bind,
  delete), one sandbox R2 bucket with a per-PR prefix, behind the sandbox's Access with service tokens for the QA gate.
- API specs (Playwright `request`) and the contract suite on the real client for these methods.
- A release tag deployed to the house account and a second account through the private ops repo's workflow.
- Retests from P0 S3: containers in Previews, and Access with a service token.

Out: runs, chats, the runner and WebSockets (P3); connectors (P4, P5); approvals (P6); retention, export and backups
(P8, which builds on this schema).

## Inputs and gates

- P1 merged into `main` (shared schema folder, product build, fixtures layer, contract suite).
- **From Wasim before W5:** the separate sandbox Cloudflare account, a scoped API token for it (secret card), an Access
  team there with a test identity provider or one-time PIN, and service tokens for an Admin, a Member, a second Member
  and an Inhouse team principal.
- **From Wasim before the release step:** the private ops repo with release credentials for the house and second
  accounts; in each, an Access application for the brand team and one for the Inhouse team with their identity
  providers; his OK for that release.
- No paid tier without Wasim's OK (Access stays on the free plan; D1 and R2 within Workers Paid).
- **Test model (Wasim, 2026-11-19):** every test, eval, smoke or check in this phase that calls a real model runs on
  Sonnet 5.5 (`claude-sonnet-5-5`) at medium effort; everything else uses the scripted model. P2 calls no model.

## Design notes

- **Layout.** `app/server/` is the product Worker (entry `app/server/index.ts`), separate from the demo Worker in
  `app/worker/`, which stays assets plus hardening's client-error route. Product config is a template,
  `app/wrangler.product.jsonc`, with no account id, host or brand name; CI and the private ops repo fill per-account
  values. The orchestrator confirms at PR0 how the Cloudflare Vite plugin takes a second config in product mode.
- **Routes** are registered in one table, `app/server/routes.ts` (orchestrator only); each worker's module exports its
  handlers. Every handler receives a verified principal. Unauthenticated routes are a closed list in the access matrix:
  the health route (P8, its own service token) and, from P8, Shopify's privacy webhooks (verified by HMAC instead of
  Access).
- **The test issuer** signs JWTs with a key generated per test run. The Worker trusts it only when built with the
  `test` flag, which no deployed config ever sets; previews use the sandbox's Access and its service tokens.
  `check-product-config.mjs` fails any deployable config (preview, house, brand) that sets the flag, trusts an issuer
  other than the account's Access team, or has a `workers.dev` or preview hostname for a brand deployment.
- **Migrations** live in `app/server/migrations/`, numbered `0001`-`0099` for P2. W2 writes them in its PR. At PR0 the
  orchestrator confirms in the D1 docs that `wrangler d1 migrations apply` applies an unapplied lower number after a
  higher one; if it doesn't, later phases hand migrations to the orchestrator to number in landing order.
- **Schema files.** Each worker owns `app/shared/contract/<resource>.ts` for its resource; the barrel `index.ts` is
  orchestrator only.
- **Audit redaction.** Never stored: secrets, tokens, photo bytes. Free-text values are stored only for keys the matrix
  marks safe; others store a length and a hash.
- **Mock first.** The contract changes land on the mock and the UI before the real client relies on them, with the
  visual suite unchanged in the demo.
- **Seed.** `app/server/seed/` writes the invented brand (an Admin, two Members, an Inhouse team principal, settings, a
  few audit lines) through the data layer, never raw SQL that skips the audit log.

## Workers

The orchestrator (Opus) writes the design into the brief of every sensitive worker (W1, W2, W5).

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| W1 | opus-worker (Opus 5.5, medium), sensitive: auth | Access verification (JWKS fetch with a short cache, issuers and audiences, fail closed, the WebSocket upgrade helper P3 uses), the test issuer, subject-to-member mapping, roles and `can`, the access matrix and object-check helper, service-token principals, support grant checks, the config check. First commit: the principal type, so W2 and W3 can start. | `app/server/auth/**`, `app/server/access-matrix.ts`, `app/shared/contract/me.ts`, `app/scripts/check-product-config.mjs` | PR0 |
| W2 | opus-worker (Opus 5.5, medium), sensitive: data | The D1 data layer, the P2 migrations and handlers: members, typed settings (C9) with key scopes, `rev` and `ifRev` with `conflict` (C6), support grants, the audit writer with redaction, the audit page query and CSV export, the photo upload and permission-checked download on R2, paging. | `app/server/db/**`, `app/server/migrations/0001`-`0099`, `app/server/api/{members,settings,grants,audit,photo}.ts`, `app/server/seed/**`, `app/shared/contract/{settings,grants,audit,members}.ts` | PR0; W1's principal type |
| W3 | sonnet-worker (Sonnet 5.5, medium) | C2, C3 and C6 contract-wide on the schema, the mock and the UI: `me()` in the account menu and Settings, actor names from ids, approvers as member ids, `rev` on every editable record, per-resource `status` with `retry()` and the error and retry states, the new error codes, the conflict notice with the current value; C9 typed settings and photo upload through `setPhoto`; the support access row in Settings. Demo looks unchanged. Mock and settings-pages owner for this phase. | `src/agent/types.ts`, `src/agent/mock.ts`, `src/agent/demo-controls.ts`, `src/state/store.ts`, `app/shared/contract/{routines,rules,memory,approvals,activity,files}.ts`, `src/screens/settings/content.ts`, `src/screens/Settings.tsx`, `src/overlays/{Menus,TeamWindow}.tsx`, `src/ui/photo.ts`, the error and retry pieces in `src/ui/**` | W1's `me.ts` |
| W4 | sonnet-worker (Sonnet 5.5, medium) | The real client for the P2 methods (fetch, schema parse both ways, error codes, `retry()`, `ifRev`), the contract suite's real target under `wrangler dev` with a seeded D1 and the test issuer, and `e2e/support/clients/real.ts`. | `src/agent/http/**`, `src/agent/contract/targets/real.ts`, `app/e2e/support/clients/real.ts` | W1, W2 merged; W3's schema |
| W5 | opus-worker (Opus 5.5, medium), sensitive: env and secrets | Product previews in the sandbox account, as a bootstrap PR into `main`: the workflow builds the demo preview as today and adds the product preview only when `app/wrangler.product.jsonc` exists, proven with `workflow_dispatch` against this branch; per-PR config generation, D1 create, migrate, seed and delete, the R2 prefix, service tokens, cleanup of leftover D1s and container apps; the P0 S3 retests written up in `docs/decisions/p2-previews-retest.md`. | `.github/workflows/preview.yml`, `.github/workflows/preview-cleanup.yml`, `app/scripts/preview-config.mjs` | Wasim's sandbox inputs |
| W6 | sonnet-worker (Sonnet 5.5, medium) | API specs: 401 without or with a bad JWT on every route; every route and object against every role from the access matrix, including two Members (one can't read the other's personal settings) and the Inhouse team with and without a grant; grant expiry; revisions and conflict; paging. A route-list test reads the matrix and fails when a route has no row or no spec. | `app/e2e/api/**` | W1, W2 merged |

## Orchestrator only

- PR0: `app/package.json` and lockfile (`jose` or WebCrypto only, checked against Cloudflare's JWT docs), the
  `app/server/` skeleton, `app/server/routes.ts`, `app/wrangler.product.jsonc`, `app/tsconfig.server.json`,
  `vite.config.ts`, `playwright.config.ts` (an `api` project and a `real` project), `app/shared/contract/index.ts`,
  `.github/workflows/ci.yml` (upload the product build for previews, run the `api` project and the real target under
  `wrangler dev`; part of W5's bootstrap PR where the workflow needs it).
- The release step, in the private ops repo: create the D1 database and R2 bucket if missing, fill the config template,
  `wrangler d1 migrations apply`, set Worker secrets through secret cards, deploy the tag, run the ship specs as a smoke;
  the release fails when a required setting is unset. Then the rollback rehearsal (redeploy the previous tag). Account
  details stay in the ops repo.
- `AGENTS.md` ("How changes land here": product previews, the sandbox account, `server/` layout, migration ranges), the
  `verify` skill and feature map, `e2e/ship/backend-core.spec.ts`.

## Order and parallelism

1. PR0 (orchestrator). W5's bootstrap PR into `main` as soon as Wasim's sandbox inputs exist, independent of PR0.
2. W1 first; W2 and W3 start from W1's principal type and `me.ts` (its first commit).
3. W4 and W6 when W1 and W2 merge.
4. The release to the house and second accounts from the branch head once the API specs pass; rollback rehearsed.
5. Final PR. At most 4 workers at once (W1, W2, W3, W5), then 2 (W4, W6).

## Browser scenarios (`e2e/ship/backend-core.spec.ts`, desktop and phone, on the product preview; each principal is a sandbox service token mapped to a seeded member)

- S1: Open the app as the Admin and see your own name and role in the account menu.
- S2: Change the time zone in Settings, reload, and it's still set.
- S3: The audit log shows that change with your name and the time; Export CSV downloads it.
- S4: Upload a profile photo, reload, and it shows in your avatar.
- S5: As a Member, the team pages are read-only and an admin-only action isn't offered.
- S6: Two tabs edit the same setting; the second save shows a conflict with the current value.
- S7: The Admin grants the Inhouse team support access; the Inhouse principal sees the audit log; after the grant ends,
  it sees health only, and the audit log shows the grant and its end.
- S8: The demo preview is unchanged (S1 of P1's ship spec, re-run).

## Acceptance

1. Every `/api/*` route returns 401 without a valid Access JWT, and with a JWT from another issuer or audience; the
   Inhouse team role comes only from its own Access application.
2. The role and object spec passes for every row of the access matrix, every role, two Members with the same role, and
   the Inhouse team with and without a grant; every route has a matrix row and a spec.
3. The config check fails a deployable config that sets the test flag, trusts any issuer but the account's Access
   team, or gives a brand deployment a `workers.dev` or preview hostname.
4. Every editable record in the contract carries `rev`, and every list reports a `status` with `retry()`; a setting
   saved with a stale `ifRev` gets `conflict` and the current record, and the UI shows it.
5. Every write and every person's action writes one audit line with redacted arguments; SQL triggers reject an update
   or delete on the audit table (tested); the CSV matches the table.
6. A photo uploads to R2 and downloads only through the Worker for a member allowed to see it.
7. A support grant gives the Inhouse team access only while it's valid; its creation, use and end are audited.
8. The contract suite passes on the mock and the real client for the P2 methods; every value parses through the
   shared schema.
9. Each PR gets a demo preview and, with the product config present, a product preview with its own seeded D1; closing
   the PR deletes the D1, the R2 prefix and any container app.
10. The P0 S3 retests have a decision record (containers in Previews, Access with a service token), and the plan is
    updated if the result changes P3's test path.
11. One release tag deploys to the house account and a second account; the release fails on an unset setting; a
    rollback is a redeploy of the previous tag, rehearsed once.
12. The demo build and its visual suite are unchanged.
13. QA PASS and the ship recording on S1 to S8.

## Must not

No permission checked only in the UI; no route without a principal outside the matrix's closed list; no test issuer in
any deployed config; no secret in the repo, a log or a job that runs PR code; no account id, hostname or brand name in
this repo; no real data in a preview; no update or delete path on the audit log; no migration that renames or drops in
the same release that stops using it; no release to an account without Wasim's OK; no retries in tests.

## Risks

- Access in front of previews is unverified (P0 S3). If service tokens can't pass a preview's Access, the QA gate runs
  on the test build under `wrangler dev` and the house deployment gets the smoke, and Wasim is told.
- Containers in Previews failed in P0; the retest decides P3's test path.
- Per-PR D1 creation can leak databases if cleanup fails; the daily cleanup lists and deletes by prefix.
- Parallel phases adding migrations: the ranges and the docs check above.
- JWKS fetch failures: cache with a short TTL and fail closed; never accept an unverified token.

## How it lands

- Branch `fleet/backend-core` from `main` after P1 merges. W5's workflows land first as a bootstrap PR into `main`,
  then `main` merges into the branch.
- Review rows: W1, W2 (with its migrations) and W5 at Sonnet plus Opus high (auth, schema, secrets); W3, W4, W6 Sonnet
  plus Opus medium.
- Final PR into `main` with the full ship gate. After merge: the demo deploys through hardening's pipeline; the product
  release to the house deployment is the orchestrator's step with Wasim's OK, then the ship specs run there as a smoke.
