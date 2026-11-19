# P8: production readiness (`fleet/production-readiness`)

Status: draft, 2026-11-19, revised after the Sonnet and Opus review. Phase plan under the backend plan
(`docs/plans/2026-11-19-backend.md`, "Production readiness"). Common rules are in its "Phase schedule (waves)"
section.

## Goal

The house deployment passes the readiness list before any real brand data: retention, export and deletion, backups
with a rehearsed restore, monitoring, the incident runbook, the Bedrock switch and the brand onboarding checklist.

**Success measure (the real slice):** the house deployment passes this readiness list.

## Scope

In, in three tracks on one branch (see the schedule):
- **Groundwork (G), wave 3:** the backup of the canonical tables to R2 and a restore that rebuilds the FTS5 index (D1
  export doesn't support virtual tables); the retention, export and person-deletion jobs; the table registry
  (`app/ops/tables.ts`) with P2's tables; the health route behind a service token; the runbook and onboarding checklist
  skeletons. In this wave the jobs are callable functions with tests only: P3's scheduler and P6's outbox aren't on
  `main` yet, so wiring comes later.
- **Coverage (C), wave 5, after P5 merges:** every P3 to P5 table in the registry, plus the BrandAgent object's run
  events and the session store's transcripts; the jobs registered as scheduler handlers (retention daily, backup
  nightly); R2 lifecycle rules as the retention backstop; monitoring signals on the health route (run failures, stuck
  runs, `mirror_error`, container restarts, a brand below its target container count); the Bedrock switch (BD9:
  manual, per brand, in the brand's own AWS account, after the evals pass on it; no automatic failover; a half-done run
  never replayed on the other provider); the data map template.
- **Final (F), wave 6:** every P6 and P7 table in the registry; the `needs_check` signal; the outbox kept paused after
  a restore until restored actions are checked against the tools' records and later deletions are applied again;
  Shopify's mandatory privacy webhooks; the retention row on Data and access; then the orchestrator's restore drill
  across D1, R2 and Durable Objects on the house deployment, each runbook step rehearsed once (pause a brand's agent,
  rotate the model key and tool tokens, remove a member, redeploy the previous release, restore), and the readiness
  list checked item by item.

Out of this repo: the scheduled monitor, monitor targets, per-brand data-flow documents and the brand release workflow
(private ops repo, BD13). This plan only states what the app exposes for them.

## Inputs and gates

- G: P2 merged. C: P5 merged. F: P6 merged for the code, P7 merged for the drill.
- **From Wasim:** an AWS account for the Bedrock test (wave 5); OK for any paid tier (Workers Logs after its pricing
  change, Bedrock usage); **the audit-log rule for person deletion** (wave 6, below).
- The branch stays open across three waves; `main` merges into it after each phase lands. Other phases don't edit the
  registry; a test fails when a D1 table, Durable Object store or R2 prefix isn't registered, so a new table can't be
  missed.
- **Test model (Wasim, 2026-11-19):** every test, eval, smoke or check in this phase that calls a real model runs on
  Sonnet 5.5 (`claude-sonnet-5-5`) at medium effort; everything else uses the scripted model. The Bedrock eval run uses Sonnet 5.5 on
  Bedrock.

## Design notes

- **The audit log and deletion.** The audit table rejects every update and delete (Architecture 11), and Settings says
  the log can't be shortened. Recommendation for Wasim: the audit log is excluded from retention and person deletion;
  deleting a person pseudonymises their member row (name and email replaced, the identity subject hashed) and keeps the
  member id, so audit lines stay consistent and name no one; audit arguments are already redacted (P2). The alternative
  is one narrowly scoped, reviewed purge path. F waits for his call.
- **Webhooks.** Shopify's privacy webhooks land on the product Worker as HMAC-verified routes, the closed exception in
  P2's access matrix; nothing on the hub changes. With level 1 data only, most requests have little to delete, but each
  is answered and audited.
- **Retention settings** sit on Data and access, an Inhouse team page that admins see read-only (decision log). The
  settings edit is made in F, after P7's settings edits are on `main`.
- **One owner for the runner's run entry.** C3 owns only `app/runner/src/run/provider.ts`; the run entry passes the
  provider from the run config (P3).

## Workers

The orchestrator (Opus) writes the design into the brief of every sensitive worker (G1, G2, C1, C3, F1, F2).

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| G1 | opus-worker (Opus 5.5, medium), sensitive: data | Backup and restore: the canonical-table backup to R2, the restore script that rebuilds FTS5, tests on P2's tables. | `app/ops/backup/**` | P2 merged |
| G2 | opus-worker (Opus 5.5, medium), sensitive: deletion | Retention, export and person deletion as callable jobs over the registry, each with a dry run and a count; the registry with P2's tables and its completeness test; the health route; API specs for it. | `app/ops/{retention,export,delete,tables}/**`, `app/ops/tables.ts`, `app/server/ops/health.ts`, `app/e2e/api/health.spec.ts` | P2 merged |
| C1 | opus-worker (Opus 5.5, medium), sensitive: deletion | Coverage of P3 to P5: their tables, Durable Object run events and transcripts in the registry, with retention defaults, export and deletion tests that prove one person's data goes and nothing else; the jobs registered as scheduler handlers; R2 lifecycle rules (as a config proposal for the orchestrator). | `app/ops/tables.ts`, `app/ops/**/tests/**`, `app/server/ops/{retention,backup}-handlers.ts` | P5 merged |
| C2 | sonnet-worker (Sonnet 5.5, medium) | Monitoring signals on the health route and their tests and API specs. | `app/server/ops/signals/**`, `app/e2e/api/signals.spec.ts` | P5 merged |
| C3 | opus-worker (Opus 5.5, medium), sensitive: secrets | The Bedrock switch: the per-brand provider setting, the gateway and runner config for Bedrock, the eval suite run on Bedrock, the rule that a run never changes provider. | `app/server/model/bedrock/**`, `app/runner/src/run/provider.ts` | P5 merged; Wasim's AWS account |
| F1 | opus-worker (Opus 5.5, medium), sensitive: data | Coverage of P6 and P7 tables, the `needs_check` signal, the outbox paused after a restore until reconciled, the retention row on Data and access. | `app/ops/tables.ts`, `app/ops/backup/reconcile/**`, `app/server/ops/signals/needs-check.ts`, `src/screens/settings/content.ts` (retention row) | P6 merged; P7's settings edits on `main` |
| F2 | opus-worker (Opus 5.5, medium), sensitive: auth | Shopify's mandatory privacy webhooks: HMAC verification, the three topics, audit lines, tests. | `app/server/webhooks/shopify-privacy/**`, `app/e2e/api/webhooks.spec.ts` | P6 merged |

## Orchestrator only

Migrations `0600`-`0699` (if any), `app/server/routes.ts`, `app/wrangler.product.jsonc` (R2 lifecycle, schedules),
lockfiles, `ci.yml`, `docs/runbook-backend.md`, `docs/onboarding-checklist.md`, `docs/data-map.md` (template only, no
brand), `AGENTS.md`, `verify` skill, `e2e/ship/production-readiness.spec.ts`, the restore drill and the rehearsals with
their records.

## Order and parallelism

1. Wave 3: G1 and G2 in parallel beside P3's chat track (2 workers).
2. Wave 5: C1, C2, C3 beside P6 (3 workers; P6 takes 5).
3. Wave 6: F1 and F2 beside P7 (2 workers; P7 takes 3). After P7 merges and `main` merges in: the drill, the
   rehearsals, the readiness list, then the final PR.

## Browser scenarios (`e2e/ship/production-readiness.spec.ts`, desktop and phone, test build)

- S1: The Inhouse team sets a retention period on Data and access, and it shows the next cleanup; an admin sees it
  read-only.
- S2: After a member's removal, their session ends and they can't sign back in.
- S3: Pause the brand's agent from Settings; a new question is refused with a clear notice; resume.
- S4: After a restore, Approvals shows the outbox paused for reconciliation until an admin confirms.

## Acceptance

1. Retention deletes past-retention rows, files, run events and transcripts on schedule (tested with a pinned clock);
   the audit log follows Wasim's rule.
2. The registry test fails when any D1 table, Durable Object store or R2 prefix isn't registered.
3. The brand export produces a complete copy of every registered store; a person's export produces their data; the
   person script deletes one person's data and nothing else (tested on the seeded brand), each with a dry run first.
4. The nightly backup lands in R2; a restore rebuilds the search index and keeps the outbox paused until reconciled.
5. The restore drill across D1, R2 and Durable Objects passed on the house deployment, with a record.
6. Each runbook step was rehearsed once on the house deployment, with a record.
7. The health route reports every listed signal behind a service token; no chat or customer content leaves the
   account; API specs pass.
8. Shopify's mandatory privacy webhooks are verified by HMAC, answered, audited and tested.
9. The Bedrock switch passes the eval suite on Bedrock for the house brand; it's off by default; a run never switches
   provider.
10. The onboarding checklist and data map template exist, with no brand detail in this repo.
11. QA PASS and the ship recording on S1 to S4; the readiness list is checked item by item.

## Must not

No real brand data in a drill; no automatic provider failover; no deletion or retention job without a dry run and a
count; no change to the audit table's triggers without Wasim's rule; no brand names, account ids or hosts in this repo;
no paid tier without Wasim's OK.

## Risks

- A long-lived branch drifts; `main` merges in after every phase, and the registry test catches tables added since.
- Durable Object point-in-time recovery and D1 Time Travel restore to different moments; the drill records the gap and
  the reconcile step covers it.
- Bedrock lacks WebSearch; the evals show what changes and the switch's description says so.

## How it lands

- Branch `fleet/production-readiness` from `main` after P2 merges.
- Review rows: G1, G2, C1, C3, F1, F2 at Sonnet plus Opus high (data, deletion, secrets, auth); C2 Sonnet plus Opus
  medium.
- Final PR after P7 with the full ship gate and the readiness record; the house release follows, with Wasim's OK.
