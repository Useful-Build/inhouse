# P2: backend core (`fleet/backend-core`)

Status: built; closing pieces in review. Locked and approved by Wasim, 2026-11-19. Phase plan under the backend plan
(`docs/plans/2026-11-19-backend.md`). Common rules are in its "Phase schedule (waves)" section.

Progress: tracked in the backend plan's "Implementation progress" section, entry P2. Read it before you start
and update it before you stop.

## Goal

Stand up the product Worker with sign-in, members, roles, settings and the audit log, backed by D1, proven on the test
build and released from one tag to the house account and a second account.

**Success measure (the real slice):** sign in, see your own name and role, change a setting, reload, it's there, the
audit log shows it; a second account deploys from the same release.

## Scope

In:
- The product Worker (`app/server/`), serving the product build and `/api/*`, with hardening's CSP and security
  headers on the assets and on its own responses.
- **Access verification.** The JWT is checked against configured issuers and audiences and fails closed. There are two
  Access applications, each on its own hostname: the brand team's gives Member or Admin from D1; the Inhouse team's,
  pinned to our identity provider, gives the Inhouse team role (an email row alone never does). The Worker accepts an
  audience only on the hostname its application covers. Every non-GET `/api/*` request also needs an `Origin` that
  matches the deployment (Access signs people in with a cookie, so a cross-site page could otherwise act as them).
- **Members.** An Admin invites a person by email. At first sign-in the verified email binds, once, to the identity
  provider's stable subject; after that the subject is the key. An identity with no invite gets a "You're not on this
  team" screen (403). Removing a member ends their access at once and keeps their member id. Re-inviting the same
  email restores that member only for the same subject; a different subject gets a new member id. The first Admin is
  seeded as an invite by the release step. Sign out goes through Access logout.
- **Service principals.** `monitor` (the health route only) and `smoke` (a Member-level principal with its own rows,
  for the release smoke). No service token maps to an Admin, the Inhouse team or a person on a house or brand
  deployment. A test issuer exists for the test build only.
- D1 schema and forward-only migrations: members, roles, settings, support grants, the audit log (append-only, SQL
  triggers reject update and delete).
- **The access matrix:** a committed table of route by role by ownership, a scope for every settings key (personal,
  brand or technical), and one of three classes for every route. *Brand data* (chats, memory, the audit log): the
  Inhouse team needs an unexpired support grant. *Baseline* (health, errors, usage numbers): the Inhouse team always
  has it (BD7). *Technical controls* (agent setup, models, run limits, data and access, tools, skills): the Inhouse
  team edits, admins read (decision log, "Roles" and "Roles: admin views"); the one admin exception is switching a
  model off or back on (decision 27a, 2026-11-20). Object checks (whose record, which role, an unexpired grant) read
  from it.
  **Amended 2026-11-20 (decision 19, "we are like an agency"):** the Inhouse team can do everything an Admin can
  (members, brand settings, models, pause, tools) plus the technical pages, with no grant. The member list and member
  photos are baseline, not brand data. A brand's chats, memory and audit log still need an Admin's live, time-boxed
  grant; the Inhouse team never creates or ends a grant itself; a person's own settings and photo stay the owner's.
- **Support grants** (BD7): an admin grants the Inhouse team time-boxed access to brand data; the grant, its use and
  its end are audited; ending it closes that access at once.
- **C2** `me()` (member id, name, role, `can`), actor ids on records, approvers as member ids, stage from the server.
- **C3** per-resource `status` with `error` and `retry()`; codes `unauthorized`, `not_found`, `rate_limited`,
  `cap_reached`; long lists page.
- **C6** `rev` on editable records, `ifRev` on writes, `conflict` returns the current record.
- **C9** settings typed per key (the brand's time zone feeds P1's `Display`); the profile photo uploads to R2 (PNG,
  JPEG or WebP by magic bytes, a size cap, `nosniff`; downloads through the Worker with a permission check).
- **Contract-wide, real where it lives in P2.** C2, C3 and C6 land in the shared schema and on the mock for every record
  in the contract (routines, rules, memory, approvals, activity, files). Real handlers in P2 are members, settings,
  grants, the audit log and the photo; the rest stay `unavailable` until their phase.
- The audit log page and its CSV export (cells that start with `=`, `+`, `-` or `@` are escaped, so a spreadsheet
  never runs them).
- The real client (`src/agent/http/`) for these methods, parsing at the boundary through the shared schema.
- **The health route** (`monitor` only) with a signal registry: deploy version, D1 reachable, migration level. Later
  phases add their signals, so the house deployment is watched from its first release.
- **The table registry** (`app/ops/tables/`): every D1 table, Durable Object store and R2 prefix with its retention
  class, person key and export flag, and a test that fails when one isn't registered. Each later phase adds its
  entries in the PR that adds the table; P8 builds on it.
- **The test build**, the proof path for this and every later phase: the product Worker under `wrangler dev` with the
  test issuer and a local D1 seeded with the invented brand. `ship.yml` gets a test-build mode for it.
- API specs (Playwright `request`), the contract suite on the real client for these methods, and the migration job.
- A release tag deployed to the house account and a second account through the private ops repo's workflow.
- **Wasim's decision Q1 (schedule): the per-PR product preview.** The backend plan put a product preview with its
  own D1 on every PR. Recommended: drop it and keep the demo preview. The ship job runs PR code and may hold no
  secret, so it can't pass a preview's Access; containers didn't start in Previews in P0; and the test build already
  proves each PR. If Wasim keeps it, W5 builds it as written below and the QA gate also drives it. Either way the ship
  recording runs on the test build.

Out: runs, chats, the runner and WebSockets (P3); connectors (P4, P5); approvals (P6); retention, export and backups
(P8, which builds on this schema and the registry).

## Inputs and gates

- P1 merged into `main` (shared schema folder, product build, fixtures layer, contract suite).
- The wave 0 retest record (`docs/decisions/p2-previews-retest.md`: containers in Previews, Access with a service
  token in front of a Worker) and Wasim's answer to Q1.
- **Wasim's decision Q3, before W2 starts:** the audit log's rule for person deletion. The audit fields are fixed in
  this phase, so the rule can't wait for P8. Recommended: the audit log is never shortened or edited; a line names its
  actor by member id only; arguments never hold a person's name, email or other identifier (those keys store a member
  id or a hash); deleting a person pseudonymises their member row and keeps the id. W2 builds to this unless he
  decides otherwise.
- **From Wasim before the candidate deploy:** the separate sandbox Cloudflare account, a scoped API token for it
  (secret card) and an Access team there with a test identity provider or one-time PIN. If Q1 keeps previews: also
  service tokens for an Admin, a Member, a second Member and an Inhouse team principal, sandbox only.
- **From Wasim before the release step:** the private ops repo with release credentials for the house and second
  accounts; in each, an Access application for the brand team and one for the Inhouse team on their hostnames, with
  their identity providers; the first Admin's email (kept in the ops repo); his OK for that release.
- No paid tier without Wasim's OK (Access stays on the free plan; D1 and R2 within Workers Paid).
- **Test model (Wasim, 2026-11-19):** every test, eval, smoke or check in this phase that calls a real model runs on
  Sonnet 5.5 (`claude-sonnet-5-5`) at medium effort; everything else uses the scripted model. P2 calls no model.

## Design notes

- **Layout.** `app/server/` is the product Worker (entry `app/server/index.ts`), separate from the demo Worker in
  `app/worker/`, which stays assets plus hardening's client-error route. Product config is a template,
  `app/wrangler.product.jsonc`, with no account id, host or brand name; CI and the private ops repo fill per-account
  values. The orchestrator confirms at PR0 how the Cloudflare Vite plugin takes a second config in product mode, and
  in the Access docs how two applications split by hostname or path.
- **Routes** are registered in one table, `app/server/routes.ts`, and every route has a row in
  `app/server/access-matrix.ts`. Both are orchestrator only: a worker's module exports its handlers and its PR body
  lists its rows. Every handler receives a verified principal. Routes outside member sign-in are a closed list in the
  matrix: the health route (the `monitor` service principal) and, only if P8 builds them, Shopify's privacy webhooks
  (verified by HMAC).
- **Headers.** The server reuses hardening's header helper. On `main` it's private to `app/worker/index.ts` (`parseHeaders`, `SECURITY_HEADERS`, `respond()`, built from the `/*` block of `public/_headers`); P2 extracts it into a shared module, and `app/worker/` and `app/public/_headers` are sensitive paths this plan names (Wasim's approval of the plan is his OK for them). The `real` Playwright project runs with the CSP
  fixture on. `img-src 'self' data:` is what stops an image link in an answer from sending data out, so no later phase
  loosens it.
- **The test issuer** signs JWTs with a key generated per test run and can mint any seeded member. The Worker trusts
  it only when built with the `test` flag, which no deployed config ever sets. `check-product-config.mjs` fails any
  deployable config that sets the flag, trusts an issuer other than the account's Access team, maps a service token to
  anything but `monitor` or `smoke`, or has a `workers.dev` or preview hostname for a brand deployment. The test
  issuer carries a canary string, and the product build check scans the server bundle
  (`wrangler deploy --dry-run --outdir`) for it, so "not in a deployed build" is checked, not assumed.
- **Migrations** live in `app/server/migrations/`, numbered `0001`-`0099` for P2; the orchestrator gives W2 its
  numbers. At PR0 the orchestrator confirms in the D1 docs that `wrangler d1 migrations apply` applies an unapplied
  lower number after a higher one; if it doesn't, later phases' migrations are numbered by the orchestrator at merge.
  The migration job (schedule, "Every phase's CI") starts here: a fresh install, and from the next phase an upgrade
  from the last release tag with that tag's API specs run against the new schema.
- **Schema files.** Each worker owns `app/shared/contract/<resource>.ts` for its resource; the barrel `index.ts` is
  orchestrator only.
- **One write, one audit line, one transaction.** A handler's change and its audit line go in one D1 batch. If the
  audit line can't be written, the change isn't either.
- **Audit redaction.** Never stored: secrets, tokens, photo bytes. The actor is a member id. Free-text values are
  stored only for keys the matrix marks safe; others store a length and a hash.
- **Mock first.** The contract changes land on the mock and the UI before the real client relies on them, with the
  visual suite unchanged in the demo.
- **Seed.** `app/server/seed/` writes the invented brand (an Admin, two Members, an Inhouse team principal, settings, a
  few audit lines) through the data layer, never raw SQL that skips the audit log.
- **Releases come from `main`.** Nothing from this branch goes to the house or second account before the final PR
  merges. Before the ship packet, the orchestrator proves the ops workflow by deploying the branch head to a
  candidate deployment in the sandbox account (invented data): create the database and bucket, migrate, deploy, the
  smoke. After Wasim approves the head SHA and it merges, the release tags the merge commit.

## Workers

The orchestrator (Opus) writes the design into the brief of every sensitive worker (W1, W2, W5). W1's first commit
freezes the principal type and the object-check interface; W2 and W3 fan out from it.

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| W1 | opus-worker (Opus 5.5, medium), sensitive: auth | Access verification (JWKS fetch with a short cache, issuers and audiences, the hostname each audience is valid on, fail closed, the `Origin` check, the WebSocket upgrade helper P3 uses), the test issuer with its canary, first sign-in binding of an invite to a subject, roles and `can`, the matrix type and the object-check helper, the `monitor` and `smoke` service principals, support grant checks, the config check. | `app/server/auth/**`, `app/shared/contract/me.ts`, `app/scripts/check-product-config.mjs` | PR0 |
| W2 | opus-worker (Opus 5.5, medium), sensitive: data | The D1 data layer, the P2 migrations and handlers: members (invite, remove, re-invite), typed settings (C9) with key scopes, `rev` and `ifRev` with `conflict` (C6), support grants, the audit writer (same batch as the change, redaction, member-id actors), the audit page query and the escaped CSV export, the photo upload (type by magic bytes, size cap) and permission-checked download on R2, paging; the health route and the signal registry's type; the table registry's type, P2's entries and the completeness test. | `app/server/db/**`, `app/server/migrations/0001`-`0099`, `app/server/api/{members,settings,grants,audit,photo}.ts`, `app/server/seed/**`, `app/server/ops/health.ts`, `app/server/ops/signals/{types,core}.ts`, `app/ops/tables/{types,core}.ts`, `app/ops/tables/completeness.test.ts`, `app/shared/contract/{settings,grants,audit,members}.ts` | PR0; W1's principal type; Wasim's Q3 |
| W3 | sonnet-worker (Sonnet 5.5, medium) | C2, C3 and C6 contract-wide on the schema, the mock and the UI: `me()` in the account menu and Settings, actor names from ids, approvers as member ids, `rev` on every editable record, per-resource `status` with `retry()` and the error and retry states, the new error codes, the conflict notice with the current value; C9 typed settings and photo upload through `setPhoto`; the Members page (invite, remove); the support access row in Settings; Sign out; the "You're not on this team" screen. Demo looks unchanged. Mock and settings-pages owner for this phase. | `src/agent/types.ts`, `src/agent/mock.ts`, `src/agent/demo-controls.ts`, `src/state/store.ts`, `app/shared/contract/{routines,rules,memory,approvals,activity,files}.ts`, `src/screens/settings/content.ts`, `src/screens/Settings.tsx`, `src/overlays/{Menus,TeamWindow}.tsx`, `src/shell/**` (the 403 screen), `src/ui/photo.ts`, the error and retry pieces in `src/ui/**` | W1's `me.ts` |
| W4 | sonnet-worker (Sonnet 5.5, medium) | The real client for the P2 methods (fetch, schema parse both ways, error codes, `retry()`, `ifRev`), the contract suite's real target under `wrangler dev` with a seeded D1 and the test issuer, and `e2e/support/clients/real.ts`. | `src/agent/http/**` (except `index.ts`), `src/agent/contract/targets/real/**` (one file per resource group; later phases add their own file, and its `index.ts` is the orchestrator's from P3), `app/e2e/support/clients/real.ts` | W1, W2 merged; W3's schema |
| W5 | opus-worker (Opus 5.5, medium), sensitive: env and secrets. **Runs only if Q1 keeps product previews.** | Product previews in the sandbox account, as a bootstrap PR into `main`: the trusted workflow builds the demo preview as today and adds the product preview only when `app/wrangler.product.jsonc` exists; per-PR config generation, D1 create, migrate, seed and delete, the R2 prefix, cleanup of leftover D1s and container apps. The service tokens stay with the QA gate on the Mac; no job that runs PR code holds one. Preview gate: the demo preview's config-equality gate stays; a PR that edits `app/wrangler.jsonc` or bumps wrangler gets no demo preview until it merges. | `.github/workflows/preview.yml`, `.github/workflows/preview-cleanup.yml`, `app/scripts/preview-config.mjs` | Wasim's Q1 and sandbox inputs |
| W6 | sonnet-worker (Sonnet 5.5, medium) | API specs: 401 without or with a bad JWT on every route; an audience refused on the other application's hostname; a non-GET without a matching `Origin` refused; every route and object against every role from the access matrix, including two Members (one can't read the other's personal settings) and the Inhouse team with and without a grant, per class; grant expiry; first sign-in, an uninvited identity, removal and re-invite; a failed audit write leaves no change; the CSV's escaping; a photo of the wrong type or size refused; revisions and conflict; paging. A route-list test reads the matrix and fails when a route has no row, class or spec. | `app/e2e/api/**` | W1, W2 merged |

## Orchestrator only

- PR0: `app/package.json` and lockfile (`jose` or WebCrypto only, checked against Cloudflare's JWT docs), the
  `app/server/` skeleton with the header helper, `app/server/routes.ts`, `app/server/access-matrix.ts`,
  `app/server/ops/signals/index.ts`, `app/ops/tables/index.ts`, `src/agent/http/index.ts` (the real client's root),
  `app/wrangler.product.jsonc`, `app/tsconfig.server.json`, `vite.config.ts`, `playwright.config.ts` (an `api` project
  and a `real` project with the CSP fixture), `app/shared/contract/index.ts`, `.github/workflows/ci.yml` (the test
  build, the `api` project, the real target and the migration job; no secret in any of them).
- `app/scripts/check-product-build.mjs` from this phase on: the server bundle scan and each new canary.
- `.github/workflows/ship.yml`, as a bootstrap PR into `main`: a test-build mode that checks out the PR's head, starts
  the test build with no secret and runs the ship spec against it.
- `e2e/smoke/product.spec.ts`: the release smoke. Read only, as the `smoke` principal: `me()`, a settings read, the
  health route as `monitor`. It replaces running the ship specs on a release, which change data.
- The release step, in the private ops repo, after the merge: create the D1 database and R2 bucket if missing, fill
  the config template, `wrangler d1 migrations apply`, set Worker secrets through secret cards, seed the first Admin's
  invite, deploy the tag to the house account, run the smoke, then deploy the same tag to the second account. The
  release fails when a required setting is unset. Account details stay in the ops repo.
- The first release has no earlier tag, so its rollback is removing the product Worker's route (nobody uses it yet).
  The rollback rehearsal (redeploy the previous tag) runs as soon as a second tag exists: the orchestrator tags the
  small PR that updates this plan's status, deploys it to the house account, redeploys the first tag, runs the smoke,
  then deploys the second again.
- `AGENTS.md` ("How changes land here": the test build, the sandbox account, `server/` layout, migration ranges), the
  `verify` skill and feature map, `e2e/ship/backend-core.spec.ts`.

## Order and parallelism

1. PR0 (orchestrator). The `ship.yml` bootstrap PR into `main`, independent of PR0. W5's bootstrap PR too, if Q1 keeps
   previews.
2. W1 first; W2 and W3 start from W1's principal type, object-check interface and `me.ts` (its first commit).
3. W4 and W6 when W1 and W2 merge, against settled routes and schemas.
4. The candidate deploy in the sandbox account once the API specs pass. Then the final PR.
5. After the merge: the release to the house account, the smoke, Wasim's own sign-in through the identity provider,
   the second account, then the rollback rehearsal.
6. At most 4 workers at once (W1, W2, W3, and W5 if it runs), then 2 (W4, W6).

## Browser scenarios (`e2e/ship/backend-core.spec.ts`, desktop and phone, on the test build; the test issuer signs each seeded member in)

- S1: Open the app as the Admin and see your own name and role in the account menu.
- S2: Change the time zone in Settings, reload, and it's still set.
- S3: The audit log shows that change with your name and the time; Export CSV downloads it.
- S4: Upload a profile photo, reload, and it shows in your avatar.
- S5: As a Member, the team pages are read-only and an admin-only action isn't offered.
- S6: Two tabs edit the same setting; the second save shows a conflict with the current value.
- S7: The Admin grants the Inhouse team support access; the Inhouse principal sees the audit log. After the grant
  ends, the audit log is refused, health and usage numbers still load, and the audit log shows the grant and its end.
- S8: The Admin invites a person; their first sign-in lands as a Member with their name.
- S9: A person who wasn't invited sees "You're not on this team". A removed member's next request is refused.
- S10: The demo preview is unchanged (S1 of P1's ship spec, re-run).

## Acceptance

1. Every `/api/*` route returns 401 without a valid Access JWT, with a JWT from another issuer or audience, and with
   the right audience on the wrong hostname; a non-GET without a matching `Origin` is refused; the Inhouse team role
   comes only from its own Access application.
2. The role and object spec passes for every row of the access matrix, every role, two Members with the same role, and
   the Inhouse team with and without a grant; every route has a matrix row, a class and a spec. Without a grant the
   Inhouse team reads baseline routes and technical controls, and no brand data.
3. The config check fails a deployable config that sets the test flag, trusts any issuer but the account's Access
   team, maps a service token to anything but `monitor` or `smoke`, or gives a brand deployment a `workers.dev` or
   preview hostname. The server bundle scan finds no test-issuer canary in a deployable build.
4. An invite binds to a subject once, at first sign-in; an uninvited identity gets 403; a removed member is refused at
   once; a re-invite restores the member only for the same subject. Sign out ends the Access session.
5. Every editable record in the contract carries `rev`, and every list reports a `status` with `retry()`; a setting
   saved with a stale `ifRev` gets `conflict` and the current record, and the UI shows it.
6. Every write and every person's action writes one audit line in the same transaction, with a member-id actor and
   redacted arguments; a failed audit write leaves no change (tested); SQL triggers reject an update or delete on the
   audit table (tested); the CSV matches the table and escapes formula cells.
7. A photo uploads to R2 only as PNG, JPEG or WebP under the size cap, and downloads only through the Worker, with
   `nosniff`, for a member allowed to see it.
8. A support grant gives the Inhouse team brand data only while it's valid; its creation, use and end are audited.
9. The product Worker's responses and assets carry hardening's CSP and headers; no page in the `real` project reports
   a CSP violation. The product's WebSocket and file downloads work under the enforced CSP (`connect-src 'self'`,
   `default-src 'self'`), checked by the CSP-guarded specs. The brand deployment's `noindex` handling is stated (the
   demo's production deploy strips the noindex line from `_headers`; Worker responses keep theirs).
10. The contract suite passes on the mock and the real client for the P2 methods; every value parses through the
    shared schema.
11. The table registry test fails when a D1 table, Durable Object store or R2 prefix isn't registered; the health
    route answers the `monitor` principal only.
12. The migration job passes: a fresh install here; from P3, an upgrade from the last tag and that tag's API specs on
    the new schema.
13. The wave 0 retests have a decision record. If Q1 keeps previews: each PR gets a demo preview and a product preview
    with its own seeded D1, closing the PR deletes the D1, the R2 prefix and any container app, and no job that runs
    PR code holds a service token.
14. The candidate deploy in the sandbox account passed before the ship packet. After the merge, one tag deploys to
    the house account, passes the read-only smoke and Wasim's own sign-in, then deploys to a second account; the
    release fails on an unset setting; the rollback rehearsal ran once a second tag existed.
15. The demo build and its visual suite are unchanged.
16. QA PASS and the ship recording on S1 to S10.

## Must not

No permission checked only in the UI; no route without a principal outside the matrix's closed list; no test issuer in
any deployed config; no service token that acts as a person, an Admin or the Inhouse team on a house or brand
deployment; no secret in the repo, a log or a job that runs PR code; no release to the house or a brand account from
anything but a merged, approved tag; no ship spec that changes data run against a release; no account id, hostname or
brand name in this repo; no real data in a preview or the sandbox; no update or delete path on the audit log; no
migration that renames or drops in the same release that stops using it; no release to an account without Wasim's OK;
no retries in tests.

## Risks

- Access with a service token in front of a Worker was unverified in P0; the wave 0 retest settles it before the
  `monitor` and `smoke` principals are built. If it fails, the smoke runs as a person through the browser and Wasim is
  told.
- How two Access applications split one deployment (hostname or path) is read from the docs at PR0; the audience
  check follows whichever it is, and the test covers it.
- If Q1 keeps previews: per-PR D1 creation can leak databases if cleanup fails; the daily cleanup lists and deletes by
  prefix.
- Parallel phases adding migrations: the ranges, the orchestrator's numbering and the migration job.
- JWKS fetch failures: cache with a short TTL and fail closed; never accept an unverified token.

## How it lands

- Branch `fleet/backend-core` from `main` after P1 merges. The `ship.yml` bootstrap PR (and W5's, if it runs) lands in
  `main` first, then `main` merges into the branch.
- Review rows: W1, W2 (with its migrations) and W5 at Sonnet plus Opus high (auth, schema, secrets); W3, W4, W6 Sonnet
  plus Opus medium; the workflow bootstrap PRs at high.
- Final PR into `main` with the full ship gate on the test build. After merge: the demo deploys through hardening's
  pipeline; the product release to the house deployment is the orchestrator's step with Wasim's OK, from the merge
  commit's tag, followed by the read-only smoke.
