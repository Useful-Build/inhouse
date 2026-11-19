# P8: production readiness (`fleet/production-readiness`)

Status: locked 2026-11-19, pending Wasim's approval to start. Phase plan under the backend plan
(`docs/plans/2026-11-19-backend.md`, "Production readiness"). Common rules are in its "Phase schedule (waves)"
section.

## Goal

The house deployment passes the readiness list before any real brand data: retention, export and deletion, backups
with a rehearsed restore, the two-week soak, the incident runbook and the brand onboarding checklist.

**Success measure (the real slice):** the house deployment passes this readiness list, and ran Watch, Act and Run for
two weeks with no approval bypass and no lost or doubled send.

## Scope

In, in three tracks on one branch, then the soak and the landing (see the schedule):
- **Groundwork (G), wave 3:** the backup of the canonical tables to R2 and a restore from it, proven on P2's tables;
  the retention, export and person-deletion jobs over P2's table registry; the deletion log; the runbook and
  onboarding checklist skeletons. In this wave the jobs are callable functions with tests only: P3's scheduler and
  P6's outbox aren't on `main` yet, so wiring comes later.
- **Coverage (C), wave 5, after P4 merges (P5's stores when P5 merges):** retention defaults, export and deletion
  tests for every P3 to P5 store in the registry, including the BrandAgent object's run events and the session store's
  transcripts; the search index rebuilt on restore, now that P3's FTS5 tables exist (D1 export doesn't support virtual
  tables); the jobs registered as scheduler handlers (retention daily, backup nightly); R2 lifecycle rules as the
  retention backstop, and backups kept 30 days; the data map template.
- **Final (F), wave 6:** the same coverage for P6's and P7's stores; the restore's watermark, snapshot and reconcile
  step; the retention row and Export everything on Data and access.
- **Wave 7:** the two-week soak on the house deployment; the restore drill rehearsed on a candidate deployment; the
  final PR and release; then the orchestrator's restore drill across D1, R2 and Durable Objects on the house
  deployment, each runbook step rehearsed once (pause a brand's agent, rotate the model key and tool tokens, remove a
  member, redeploy the previous release, restore), and the readiness list checked item by item.

Moved out of this phase, so nothing waits three waves for it: the table registry and the health route are built in P2,
and each phase adds its own registry entries and health signals (run failures, stuck runs, `mirror_error`, container
restarts and the shortfall in P3; `needs_check` in P6). This phase checks the list is complete.

**Wasim's decision Q5 (schedule): the Bedrock switch.** BD9 puts a manual, per-brand Bedrock switch in this plan.
Recommended: defer it to the first brand that asks. No brand needs it yet, it costs an Opus worker, an AWS account and
a paid eval run, and P3 already keeps the one rule that has to hold from day one (a session never changes provider).
If Wasim keeps it, C3 below builds it in wave 5 and its eval run moves to wave 7, when the injection and Run sets
exist to run on it.

**Shopify's privacy webhooks.** Shopify's docs require the three compliance webhooks for App Store apps and don't say
whether a Dev Dashboard app installed on one store needs them. Before F2 starts, the orchestrator confirms it in the
docs or gets it in writing from Partner support. If they don't apply, F2 and its unauthenticated route are dropped,
with a decision record. If they do, or it stays unclear, F2 builds.

Out of this repo: the scheduled monitor, monitor targets, per-brand data-flow documents and the brand release workflow
(private ops repo, BD13). This plan only states what the app exposes for them.

## Inputs and gates

- G: P2 merged. C: P4 merged. F: P6 merged for the code, P7 merged for its stores, its settings edits and the soak.
- **From Wasim:** decision Q5; if the switch stays, an AWS account for the Bedrock test; OK for any paid tier (Workers
  Logs after its pricing change, Bedrock usage); **decision Q8, the soak's model and spend** (below). The audit-log
  rule for person deletion is decision Q3, taken before P2's data layer, not here.
- The branch stays open across four waves; `main` merges into it after each phase lands. P2's completeness test fails
  when a D1 table, Durable Object store or R2 prefix isn't registered, on every phase's branch, so a new table can't
  be missed.
- **Test model (Wasim, 2026-11-19):** every test, eval, smoke or check in this phase that calls a real model runs on
  Sonnet 5.5 (`claude-sonnet-5-5`) at medium effort; everything else uses the scripted model. If the switch stays, the
  Bedrock eval run uses Sonnet 5.5 on Bedrock.

## Design notes

- **The audit log and deletion** follow Wasim's decision Q3 (P2): as recommended there, the audit log is excluded from
  retention and person deletion, a line names its actor by member id only and holds no person identifier in its
  arguments, and deleting a person pseudonymises their member row (name and email replaced, the identity subject
  hashed) and keeps the id. Backups older than 30 days are gone, so a deleted person leaves them within that window.
- **The deletion log.** Every person deletion and retention run appends what it removed (ids only, no content) to an
  R2 prefix outside the backup set. A restore can't rewind it, so deletions made after the restore point are applied
  again.
- **A restore, step by step.** (1) Snapshot the audit table, the outbox rows and the deletion log to R2 before
  touching anything. (2) Restore, and write a restore record: the D1 point, the R2 state and each Durable Object's
  recovery time. D1 Time Travel and Durable Object recovery land on different moments, so the earliest is the
  watermark. (3) Append the audit lines newer than the restore point back from the snapshot (from the daily copy if
  the database couldn't be read, with the gap recorded), so audit history never rewinds. (4) Hold every `approved` and
  `sending` outbox row and keep the outbox paused. (5) Reconcile: check each held action against the tool's own
  record, replay the deletion log past the watermark, then an admin confirms and the outbox resumes. A successful
  import isn't a safe restore until step 5 is done.
- **The soak.** It starts at P7's house release and runs 14 days on the house deployment, with the read fixture, the
  write store and a real model. The nightly workflow drives a fixed daily set (the driver and the evidence query are
  built in P7, so they're on `main` when the soak starts): the morning check, approved drafts
  with and without Undo, an allowed restock, a refund that must wait, one Pause and resume. The evidence is a query
  over the audit log and the write store's own records: every approved intent has at most one effect in the store, no
  effect lacks an approval or a policy record, and no `needs_check` row was resent. A doubled send or a bypass
  restarts the 14 days after its fix; any other release doesn't. **Wasim's decision Q8:** the test-model rule puts the
  soak on Sonnet 5.5 at medium. Recommended: run it on the product model he chose at P3 instead, as a named exception,
  since the soak proves the product; and a spend limit for the 14 days.
- **Where the drill runs.** Nothing unapproved goes to the house deployment. Before the ship packet, the orchestrator
  deploys this branch's head to a candidate deployment in the sandbox account (invented data) and rehearses the
  restore there. After Wasim approves the head and it merges, the release goes to the house deployment, and the real
  drill and the runbook rehearsals run there, before any brand's data.
- **Webhooks, if F2 builds.** Shopify's privacy webhooks land on the product Worker as HMAC-verified routes, the
  closed exception in P2's access matrix; nothing on the hub changes. With level 1 data only, most requests have
  little to delete, but each is answered and audited.
- **Retention settings** sit on Data and access, an Inhouse team page that admins see read-only (decision log). The
  settings edit is made in F, after P7's settings edits are on `main`.
- **The Bedrock switch, if it stays.** P3 owns the run config's provider field and the gateway route. C3 adds the
  Bedrock provider behind them (`app/server/model/bedrock/` and `app/runner/src/run/provider.ts`) and hands the one
  line that registers it to the orchestrator.

## Workers

The orchestrator (Opus) writes the design into the brief of every sensitive worker (all of them).

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| G1 | opus-worker (Opus 5.5, medium), sensitive: data | Backup and restore: the canonical-table backup to R2, the restore script with its pre-restore snapshot and restore record, tests on P2's tables. No search index yet. | `app/ops/backup/**` (except `fts/` and `reconcile/`) | P2 merged |
| G2 | opus-worker (Opus 5.5, medium), sensitive: deletion | Retention, export and person deletion as callable jobs over P2's registry, each with a dry run and a count; the deletion log; tests on P2's tables. | `app/ops/{retention,export,delete}/**` | P2 merged |
| C1 | opus-worker (Opus 5.5, medium), sensitive: deletion | Coverage of P3 to P5: retention defaults for their registry entries, export and deletion tests that prove one person's data goes and nothing else (tables, Durable Object run events, transcripts), the search index rebuilt on restore, the jobs registered as scheduler handlers, R2 lifecycle rules and the 30-day backup rule (as a config proposal for the orchestrator), the data map template's store list. | `app/ops/coverage/chat-watch-connectors/**`, `app/ops/backup/fts/**`, `app/server/ops/{retention,backup}-handlers.ts` | P4 merged; P5 merged for its stores |
| C3 | opus-worker (Opus 5.5, medium), sensitive: secrets. **Runs only if Q5 keeps the switch.** | The Bedrock switch: the per-brand provider setting, the Bedrock provider for the gateway route and the runner, off by default. Its eval run is the orchestrator's, in wave 7. | `app/server/model/bedrock/**`, `app/runner/src/run/provider.ts` | P4 merged; Wasim's Q5 and AWS account |
| F1 | opus-worker (Opus 5.5, medium), sensitive: data | Coverage of P6 and P7 stores; the reconcile step (held rows, the check against the tools' records, the deletion log replay, the audit re-append, the admin's confirm); the retention row and Export everything on Data and access, with their API and client. | `app/ops/coverage/act-run/**`, `app/ops/backup/reconcile/**`, `app/server/api/data-access.ts`, `app/shared/contract/data-access.ts`, `src/agent/http/data-access.ts`, `src/screens/settings/content.ts` and `src/screens/Settings.tsx` (the retention row and the export button) | P6 merged; P7 on `main` for its stores and the settings edit |
| F2 | opus-worker (Opus 5.5, medium), sensitive: auth. **Runs only if the webhooks apply.** | Shopify's privacy webhooks: HMAC verification, the three topics, audit lines, tests. | `app/server/webhooks/shopify-privacy/**`, `app/e2e/api/webhooks.spec.ts` | P6 merged; the docs check |

## Orchestrator only

Migrations `0600`-`0699` (if any), `app/server/routes.ts`, `app/server/access-matrix.ts`, `app/ops/tables/index.ts`,
`src/agent/http/index.ts`, `app/wrangler.product.jsonc` (R2 lifecycle, schedules), lockfiles, `ci.yml`,
`docs/runbook-backend.md`, `docs/onboarding-checklist.md` (two
Shopify apps per brand, the Slack app, the two Access applications, the first Admin, the WebFetch list),
`docs/data-map.md` (template only, no brand), `AGENTS.md`, `verify` skill, `e2e/ship/production-readiness.spec.ts`,
the docs check on the webhooks, the candidate rehearsal, the soak record, the restore drill and the rehearsals with
their records, and the Bedrock eval run if Q5 keeps the switch.

## Order and parallelism

1. Wave 3: G1 and G2 in parallel beside P3's chat track (2 workers).
2. Wave 5: C1, and C3 if it runs, beside P6 (at most 2 workers; P6 takes 5).
3. Wave 6: F1, and F2 if it runs, beside P7 (at most 2 workers; P7 takes 3). F1's coverage of P7's stores and its
   settings edit wait until P7 merges and `main` merges in.
4. Wave 7: the soak runs from P7's house release. Meanwhile the candidate rehearsal, then the final PR with the soak
   record once the 14 days are clean. After the merge and the house release: the drill, the rehearsals, the readiness
   list.

## Browser scenarios (`e2e/ship/production-readiness.spec.ts`, desktop and phone, test build)

- S1: The Inhouse team sets a retention period on Data and access, and it shows the next cleanup; an admin sees it
  read-only.
- S2: After a member's removal, their session ends and they can't sign back in.
- S3: Pause the brand's agent from Settings; a new question is refused with a clear notice; resume.
- S4: After a restore, Approvals shows the outbox paused for reconciliation until an admin confirms.
- S5: Export everything produces one download; it lists every store in the registry.

## Acceptance

1. Retention deletes past-retention rows, files, run events and transcripts on schedule (tested with a pinned clock);
   the audit log follows Wasim's rule (Q3).
2. Every store in the registry has a retention class, an export test and a deletion test; the registry's completeness
   test still passes with every phase merged.
3. The brand export produces a complete copy of every registered store; a person's export produces their data; the
   person script deletes one person's data and nothing else (tested on the seeded brand), each with a dry run first;
   every deletion is in the deletion log.
4. The nightly backup lands in R2 and is kept 30 days. A restore takes its snapshot first, rebuilds the search index,
   writes its restore record, re-appends the audit lines past the restore point, replays the deletion log, and keeps
   every `approved` and `sending` row held with the outbox paused until an admin confirms the reconcile (each step
   tested).
5. The soak ran 14 clean days on the house deployment after P7's release: no approved intent with more than one
   effect, no effect without an approval or policy record, no resent `needs_check`; the record holds the query and its
   result.
6. The restore was rehearsed on the candidate deployment before the ship packet. After the release, the restore drill
   across D1, R2 and Durable Objects passed on the house deployment, with a record.
7. Each runbook step was rehearsed once on the house deployment, with a record.
8. The health route reports every signal the backend plan lists (run failures, stuck runs, `mirror_error`, container
   restarts, `needs_check` rows, a brand below its target container count) to the `monitor` principal only; no chat or
   customer content leaves the account.
9. Shopify's privacy webhooks: either a decision record shows they don't apply to these apps and no such route
   exists, or they're verified by HMAC, answered, audited and tested.
10. The Bedrock switch: either deferred by Wasim's decision with a record, or it passes the eval suite and the
    injection and Run sets on Bedrock for the house brand and is off by default. Either way a session never switches
    provider (P3).
11. The onboarding checklist and data map template exist, with no brand detail in this repo.
12. QA PASS and the ship recording on S1 to S5; the readiness list is checked item by item.

## Must not

No real brand data in a drill or the soak; no drill or rehearsal on the house deployment from an unapproved head; no
automatic provider failover; no deletion or retention job without a dry run and a count; no change to the audit
table's triggers; no restore that resumes the outbox before reconciliation; no brand names, account ids or hosts in
this repo; no paid tier without Wasim's OK.

## Risks

- A long-lived branch drifts; `main` merges in after every phase, and P2's completeness test catches stores added
  since.
- Durable Object point-in-time recovery and D1 Time Travel restore to different moments; the restore record's
  watermark and the reconcile step cover the gap, and the drill records it.
- The soak adds two weeks before the first brand. That's the backend plan's own success measure; a bypass or doubled
  send found there is cheaper than one found on a brand.
- If the switch stays: Bedrock lacks WebSearch; the evals show what changes and the switch's description says so.

## How it lands

- Branch `fleet/production-readiness` from `main` after P2 merges.
- Review rows: every worker PR at Sonnet plus Opus high (data, deletion, secrets, auth).
- Final PR after P7 and a clean soak, with the full ship gate, the candidate rehearsal's record and the soak record;
  the house release follows, with Wasim's OK, then the drill, the rehearsals and the readiness sign-off.
