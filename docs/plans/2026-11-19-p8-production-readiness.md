# P8: production readiness (`fleet/production-readiness`)

Status: re-cut on 2026-11-22 into P8a (Watch readiness, Part 1) and P8b (Part 2). Wasim decided the split; see
[the master plan](2026-11-22-master-plan.md), its "Line A (A9)" section and "The Watch soak". The first version was
locked and approved by Wasim on 2026-11-19. Phase plan under the backend plan (`docs/plans/2026-11-19-backend.md`,
"Production readiness"). Common rules are in its "Phase schedule (waves)" section.

Progress: tracked in the backend plan's "Implementation progress" section, entry P8. Read it before you start
and update it before you stop.

## Done: groundwork (G1, G2)

Merged into `fleet/production-readiness` on 2026-11-20, as tested callable jobs over P2's tables and registry:

- **G1** (#131): the backup of the canonical tables to R2 and a restore from it, with its pre-restore snapshot, checks,
  write, proof and restore record. Derived FTS5 tables are skipped. A restore ends `restored_unreconciled` today
  (`app/ops/backup/restore.ts`).
- **G2** (#130): retention, export and person deletion over the registry, each with a dry run and a count, and the
  deletion log.

## P8a: Watch readiness (Part 1)

### Goal

The house deployment is ready for a Watch client's real data: a restore that finishes at Watch with deletions kept
deleted, the Data and access screen, the privacy webhooks if they apply, server-side safety switches for Watch, the
runbook and onboarding checklist, the Watch soak's evidence, and the launch-critical P9 items.

**Success measure (the real slice):** the house runs P4, P5, P6a and P8a, the Watch soak passed, the readiness list
below passes including the house restore drill, and a fresh deploy to the second account passes its smoke.

### Scope

In: the pieces in the worker table (R, D, F2, S, O, K, P), the Watch soak, the candidate rehearsal, the house restore
drill and runbook rehearsals, and the second-account fresh deploy and smoke.

Out (P8b or later): the outbox hold and the check against the tools' records in a restore, coverage for P6b's and P7's
stores, the 14-day write soak, the Bedrock switch (C3), and the P9 items that aren't launch-critical.

Out of this repo, as before: the scheduled monitor, monitor targets, per-brand data-flow documents and the brand
release workflow (private ops repo, BD13). This plan only states what the app exposes for them. The demo's
`monitor.yml` and `docs/runbook.md` stay as they are; `docs/runbook-backend.md` links to `runbook.md`. The product
rollback is a tag redeploy through the private ops workflow, not `deploy.yml`'s `rollback_to`.

### Inputs and gates

- **Merge `main` into `fleet/production-readiness` first**, through a PR. The branch has only G1 and G2 on an old
  `main`; no worker starts before this lands.
- **C1 is line B's (B2):** coverage of the P2 to P6a stores (memory records and their states, run events,
  transcripts), the FTS rebuild on restore, the jobs registered as scheduler handlers, the R2 lifecycle rules and the
  data map template. The restore drill's FTS step needs it, and so does D's export completeness.
- **File owners.** `src/screens/Settings.tsx`, `src/screens/settings/content.ts` and `src/agent/mock.ts` have one
  owner at a time. B2 owns them during P6a. D and any P edit to them start only after P6a merges into `main` and
  `main` merges here, or after a written handover from B2.
- **F2's docs check** is the orchestrator's, before F2 starts.
- **From Wasim:** the nightly soak step (workflows are a sensitive path); OK for each house release and the final
  head SHA; each step of the house restore drill; the second account (below); OK for any paid tier.
- **Test model (Wasim, 2026-11-19):** every test, eval, smoke or check that calls a real model runs on Sonnet 5.5
  (`claude-sonnet-5-5`) at medium effort; everything else uses the scripted model. The Watch soak is the named
  exception: it runs on the product model (decision 3 and Q8).

### Workers

The orchestrator (Opus) writes the design into the brief of every sensitive worker.

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| R | opus-worker (Opus 5.5, medium), sensitive: data | A restore that finishes at Watch. After G1's write: re-append the audit lines newer than the restore point from the snapshot, replay the deletion log past the watermark, then an admin confirms and the restore ends `restored` (audited). Tests prove a person deleted after the backup stays gone across D1, R2 and the Durable Objects once the restore finishes. Moved from F1. The outbox hold and the tool check stay in P8b; the step order leaves room for them. | `app/ops/backup/reconcile/**`, the end of `app/ops/backup/restore.ts` and `manifest.ts` (the new status), the confirm handler (route and access row are the orchestrator's) | `main` merged in; C1's FTS rebuild for the drill's FTS step |
| D | opus-worker (Opus 5.5, medium), sensitive: data | The Data and access screen: the retention row (Inhouse team sets it, admins see it read-only, it shows the next cleanup) and "Export everything" as one download over the P2 to P6a stores, with their API, contract and client. The download is the brand's shared data and the caller's own (`brandForCaller`, master plan standing decision 10, interim pending Wasim): never another person's personal rows, members as route 3 shows them, each store's rule declared in `app/ops/export/brand-for-caller.ts`; memory bounded (R2 paged by cursor, each object streamed in base64 pieces); a brand past one request's budget refused `too_large` with no audit line; the page checks first through route 96 so a refusal shows in the app. | `app/server/api/data-access.ts`, `app/shared/contract/data-access.ts`, `src/agent/http/data-access.ts`, the retention row and export button in `Settings.tsx`, `settings/content.ts` and `mock.ts` | C1 merged; P6a merged into `main` or B2's written handover |
| F2 | opus-worker (Opus 5.5, medium), sensitive: auth. **Runs only if the webhooks apply or it stays unclear.** | Shopify's privacy webhooks: HMAC verification, the three topics, answered and audited, tests. | `app/server/webhooks/shopify-privacy/**`, `app/e2e/api/webhooks.spec.ts` | `main` merged in; the docs check |
| S | opus-worker (Opus 5.5, medium), sensitive: guards | The Watch safety switches, server-side: a WebSearch off switch (none exists today); a WebFetch allowlist that's empty by default, where empty means no host (today an empty `t:webfetch` means any public host, in `server/egress/webfetch.ts`, `server/api/runs.ts` and the runner's guard options); bell-only delivery and no external writes enforced at stage Watch; web tools off for clients until their eval cases pass, set by the Inhouse team only. | `app/server/egress/webfetch.ts`, the WebFetch and WebSearch parts of `app/server/api/runs.ts` and `app/server/model/request.ts`, `app/runner/src/guards/{options,webfetch}.ts`, the stage checks on delivery and tool writes, their tests | `main` merged in |
| O | sonnet-worker (Sonnet 5.5, medium) for the docs; the teardown step is opus-worker (Opus 5.5, medium), sensitive: infra | The runbook: pause a brand, rotate the model key and tool tokens, remove a member, restore, teardown, redeploy the previous release. The onboarding checklist (two Shopify apps per brand, the Slack app, the two Access applications, the first Admin, the WebFetch list). The teardown step deletes each container application explicitly, listing them before and after, and fails if any remain (P0 found deleting a Worker leaves them). | `docs/runbook-backend.md`, `docs/onboarding-checklist.md`, `docs/data-map.md` (template only, no brand) | `main` merged in; R for the restore steps |
| K | sonnet-worker (Sonnet 5.5, medium) | The Watch soak driver and evidence query, moved from P7 W3. Daily checks: the morning check completed; exactly one bell notice per alert; memory saves and approvals behaved; connector reads succeeded; failed runs recovered; no guard or leak bypass. A missing or budget-skipped check reports not clean. `INHOUSE_HOUSE_SOAK` (P6's outbox only) is dropped from Part 1. | `app/ops/soak/**` | `main` merged in; P6a's memory approval shape for that check |
| P-ops | orchestrator, with line B | The 0142 row count and the predrain fix, before line B's P4 house release. **Already in progress** (ops). | ops | |
| P-auth | opus-worker (Opus 5.5, medium), sensitive: auth | The Inhouse-team sign-in loop (`wrong_kind`); `err.message` logging fixed, or proven safe, before client data. | `app/server/auth/**` for the loop (Wasim's OK, sensitive path), the server's error-text helpers | `main` merged in |
| P-ui | sonnet-worker (Sonnet 5.5, medium) | Today shows no failed-check card before 06:10; the empty chat stops saying no tools are connected while the composer disagrees. The loading-flash and stale-retry-card fixes join only if QA shows they block a core flow; otherwise they're Part 2. | The Today and empty-chat screens and their server reads | `main` merged in; the file owners rule for `mock.ts` |

Line B may mark one of its lows launch-critical, with a reason; it joins P-ui or P-auth.

### Orchestrator only

Migrations `0600`-`0699` (if any), `app/server/routes.ts`, `app/server/access-matrix.ts`, `app/ops/tables/index.ts`,
`src/agent/http/index.ts`, `app/wrangler.product.jsonc`, lockfiles, `ci.yml` and the nightly workflow's soak step,
`AGENTS.md`, the `verify` skill, `e2e/ship/production-readiness.spec.ts`, the F2 docs check, the candidate rehearsal,
the soak record, the house restore drill and the runbook rehearsals with their records, and the second-account deploy
and smoke.

### Order and parallelism

At most 3 workers at once. Every sensitive piece runs on opus-worker.

1. The orchestrator merges `main` into the branch and runs the F2 docs check. P-ops is already moving.
2. Batch 1: K, R and S. K comes first because the soak is already counting from P4's house release; days before K is
   live report not clean, which is allowed (the gate is 3 consecutive clean days).
3. Batch 2: P-auth, O, and F2 if it builds.
4. Batch 3: D and P-ui, once P6a and C1 have merged (or B2 hands over).

### The Watch soak

As in the master plan:

- **Start.** It starts at P4's house release, at stage Watch, and each later release adds to what's checked.
- **Gate.** It passes after 3 consecutive clean days with P4, P5, P6a and P8a all live (decision 3).
- **Daily evidence.** K's driver and evidence query check the six items in K's row every day.
- **What doesn't count.** A missing or budget-skipped check doesn't count as clean.
- **Restarts.** A bypass or a lost or doubled notice restarts the count. A release that changes behaviour restarts the
  3-day window.
- **Model and spend.** The product model with a spend limit, per Q8, inside the house's $50 monthly cap.

### Release order

Each step with Wasim's OK.

1. P8a's code reaches the house mid-soak, so its retention and backup jobs run there.
2. The candidate rehearsal: this branch's head on a candidate deployment in the sandbox account, invented data, the
   restore rehearsed there.
3. The final PR into `main` with the full ship gate and Wasim's exact-SHA approval.
4. The house restore drill, from the approved head, across D1, R2 and Durable Objects, then the runbook rehearsals.

### The second-account fresh deploy and smoke

Part of "Part 1 done". A fresh deploy of the approved release to the second account (the brand stand-in, Wasim's
decision of 2026-11-20), with invented data, through the private ops workflow. The smoke covers: both Access apps (the
brand's and the Inhouse team's) and a support-access grant; payload logging off on the model key; the private
monitor's alert path exercised once. **From Wasim:** the second account on Workers Paid as decided on 2026-11-20, its
credentials through a secret card, a model key with payload logging off, and his OK for the deploy.

### Browser scenarios (`e2e/ship/production-readiness.spec.ts`, desktop and phone, test build)

- S1: The Inhouse team sets a retention period on Data and access, and it shows the next cleanup; an admin sees it
  read-only.
- S2: After a member's removal, their session ends and they can't sign back in.
- S3: Pause the brand's agent from Settings; a new question is refused with a clear notice; resume.
- S4: Export everything produces one download; it lists every P2 to P6a store in the registry (each marked all, part
  or none for the caller).
- S5: At stage Watch, a WebFetch to a host off the list and a WebSearch are refused with a clear notice.

### Acceptance

1. A restore runs snapshot, write, FTS rebuild, audit re-append and deletion-log replay, and ends `restored` only after
   an admin's audited confirm; each step is tested.
2. A person deleted after a backup's point stays gone across D1, R2 and the Durable Objects once that backup is
   restored (tested on the seeded brand).
3. Data and access shows the retention row (editable by the Inhouse team, read-only for admins) and Export everything;
   the export lists every P2 to P6a store in the registry and holds the brand's shared data and the caller's own, never
   another person's personal rows (standing decision 10).
4. Shopify's privacy webhooks: either a decision record shows they don't apply and no such route exists, or they're
   verified by HMAC, answered, audited and tested.
5. With `t:webfetch` empty, WebFetch reaches no host; with WebSearch off, no web search tool reaches the model; at
   stage Watch no notice leaves except through the bell and no tool write runs; web tools stay off for a brand until
   the Inhouse team turns them on. Each is tested at the server, not only in the UI.
6. The runbook has every step listed under O, each rehearsed once on the house deployment with a record; the
   onboarding checklist and data map template exist with no brand detail in this repo.
7. Teardown leaves no container application behind (listed before and after in the rehearsal).
8. K's driver and evidence query run clean once against the test build, and report a missing or budget-skipped check as
   not clean.
9. The Watch soak passed: 3 consecutive clean days with P4, P5, P6a and P8a live; the record holds the query and its
   results.
10. Each launch-critical P9 item is fixed with a test, or for `err.message`, proven safe with a record.
11. The restore was rehearsed on the candidate deployment before the ship packet; the house restore drill passed after
    the release, with a record.
12. The second-account fresh deploy passed its smoke (both Access apps, a support-access grant, payload logging off,
    the monitor's alert path).
13. The health route reports every Watch signal the backend plan lists (run failures, stuck runs, `mirror_error`,
    container restarts, a brand below its target container count) to the `monitor` principal only; no chat or
    customer content leaves the account. `needs_check` rows join in P8b.
14. QA PASS and the ship recording on S1 to S5; the readiness list is checked item by item.

### Must not

No real brand data in a drill, a rehearsal or the soak; no drill or rehearsal on the house deployment from an
unapproved head; no restore marked done before the audit re-append, the deletion-log replay and the admin confirm; no
deletion or retention job without a dry run and a count; no change to the audit table's triggers; no WebFetch to any
host by default; no external write or non-bell delivery at stage Watch; no edit to `Settings.tsx`, `content.ts` or
`mock.ts` while B2 owns them; no automatic provider failover; no brand names, account ids or hosts in this repo; no
paid tier without Wasim's OK.

## P8b (Part 2)

Built once the first client signs, before any client moves to Act.

- **F1's rest:** the outbox hold in a restore (every `approved` and `sending` row held, the outbox paused) and the
  check of each held action against the tool's own record, before the admin confirm; coverage for P6b's and P7's
  stores.
- **The 14-day write soak** on the house deployment, on the product model with a spend limit (Q8): approved drafts with
  and without Undo, an allowed restock, a refund that must wait, one Pause and resume. Its evidence: every approved
  intent has at most one effect in the store, no effect lacks an approval or a policy record, and no `needs_check` row
  was resent. A doubled send or a bypass restarts the 14 days after its fix.
- **Bedrock (C3), deferred** (Q5) to the first brand that asks.

## Design notes

- **The audit log and deletion** follow Wasim's decision Q3 (P2): the audit log is excluded from retention and person
  deletion, a line names its actor by member id only and holds no person identifier in its arguments, and deleting a
  person pseudonymises their member row (name and email replaced, the identity subject hashed) and keeps the id.
  Backups older than 30 days are gone, so a deleted person leaves them within that window.
- **The deletion log.** Every person deletion and retention run appends what it removed (ids only, no content) to an
  R2 prefix outside the backup set. A restore can't rewind it, so deletions made after the restore point are applied
  again.
- **A restore, step by step.** (1) Snapshot the audit table and the deletion log to R2 (and the outbox rows, from
  P8b) before touching anything. (2) Restore, and write a restore record: the D1 point, the R2 state and each Durable
  Object's recovery time. D1 Time Travel and Durable Object recovery land on different moments, so the earliest is the
  watermark. (3) Append the audit lines newer than the restore point back from the snapshot (from the daily copy if
  the database couldn't be read, with the gap recorded), so audit history never rewinds. (4) P8b only: hold every
  `approved` and `sending` outbox row, keep the outbox paused, and check each held action against the tool's record.
  (5) Replay the deletion log past the watermark, then an admin confirms. A successful import isn't a safe restore
  until step 5 is done.
- **Where the drill runs.** Nothing unapproved goes to the house deployment. The candidate rehearsal runs in the
  sandbox account with invented data; the real drill and the rehearsals run on the house after Wasim approves the head
  and it's released.
- **Webhooks, if F2 builds.** Shopify's privacy webhooks land on the product Worker as HMAC-verified routes, the
  closed exception in P2's access matrix; nothing on the hub changes. With level 1 data only, most requests have
  little to delete, but each is answered and audited. Shopify's docs require them for App Store apps and don't say
  whether a Dev Dashboard app installed on one store needs them, so the orchestrator checks the docs or asks Partner
  support in writing first. If they don't apply, F2 and its route are dropped with a decision record.
- **Retention settings** sit on Data and access, an Inhouse team page that admins see read-only (decision log).
- **The WebFetch default changes meaning.** Empty used to mean any public host. S makes it mean none, so the settings
  copy that explains the field changes with it (in `content.ts`, under the file owners rule), and the onboarding
  checklist sets each brand's list.
- **The Bedrock switch, if it comes back.** P3 owns the run config's provider field and the gateway route. C3 adds the
  Bedrock provider behind them (`app/server/model/bedrock/` and `app/runner/src/run/provider.ts`) and hands the one
  line that registers it to the orchestrator. A session never switches provider (P3).

## Risks

- A long-lived branch drifts; `main` merges in before the work and after each phase lands, and P2's completeness test
  catches stores added since.
- Durable Object point-in-time recovery and D1 Time Travel restore to different moments; the restore record's
  watermark and the replay cover the gap, and the drill records it.
- The soak counts from P4's house release while K is still being built; early days report not clean, which only
  delays the gate.
- Three files are shared with line B; the file owners rule and B2's handover keep one owner at a time.

## How it lands

- Branch `fleet/production-readiness`, with `main` merged in first.
- Review rows: every worker PR at Sonnet plus Opus high for the sensitive pieces (data, auth, guards, infra); Sonnet
  plus Opus medium for K and P-ui.
- Final PR into `main` with the full ship gate, the candidate rehearsal's record and the soak record; Wasim approves
  the exact head SHA. The house release follows with his OK, then the drill, the rehearsals, the readiness sign-off and
  the second-account smoke.

## Dropped in the re-cut (2026-11-22)

- The four-wave schedule (waves 3, 5, 6 and 7) and its gates on P6 and P7 merging.
- F1 as one row: its restore steps moved into R, its Data and access work into D, and the rest into P8b.
- The success measure of two weeks of Watch, Act and Run before any brand: it's now the Watch soak (Part 1) and the
  14-day write soak (P8b).
- The soak driver living in P7 and `INHOUSE_HOUSE_SOAK` in Part 1.
- The browser scenario where Approvals shows the outbox paused after a restore (P8b).
- The Bedrock decision as an open question: Q5 deferred it, so C3 is listed under P8b as deferred.
