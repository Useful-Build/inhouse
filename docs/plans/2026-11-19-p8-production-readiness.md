# P8: production readiness (`fleet/production-readiness`)

Status: draft, 2026-11-19. Phase plan under the backend plan (`docs/plans/2026-11-19-backend.md`, "Production
readiness"). Common rules are in its "Phase schedule (waves)" section.

## Goal

The house deployment passes the readiness list before any real brand data: retention, export and deletion, backups
with a rehearsed restore, monitoring, the incident runbook, the Bedrock switch and the brand onboarding checklist.

**Success measure (the real slice):** the house deployment passes this readiness list.

## Scope

In, in three tracks on one branch (see the schedule):
- **Groundwork (G), from wave 3:** the nightly backup of the canonical tables to R2 and a restore that rebuilds the
  FTS5 index (D1 export doesn't support virtual tables); the retention job framework (per-brand settings with
  defaults, run daily by the BrandAgent alarm, R2 lifecycle rules as the backup); the export and person-deletion
  script framework; the health route behind a service token; the runbook and onboarding checklist skeletons.
- **Coverage (R), wave 5:** retention, export, deletion and backup extended to every table P3 to P6 added; monitoring
  signals on the health route (run failures, stuck runs, `mirror_error`, container restarts, `needs_check` rows, a
  brand below its target container count); Shopify's mandatory privacy webhooks; the Bedrock switch (BD9: manual, per
  brand, in the brand's own AWS account, after the evals pass on it; no automatic failover; a half-done run never
  replayed on the other provider); the data map template.
- **Final check (F), wave 6, after P7:** the restore drill across D1, R2 and Durable Objects on the house deployment,
  with the outbox paused until restored actions are checked against the tools' records and later deletions are
  applied again; each runbook step rehearsed once (pause a brand's agent, rotate the model key and tool tokens, remove a
  member, redeploy the previous release, restore); the readiness list checked item by item.

Out of this repo: the scheduled monitor, monitor targets, per-brand data-flow documents and the brand release workflow
(private ops repo, BD13). This plan only states what the app exposes for them.

## Inputs and gates

- G: P2 merged (the D1 schema exists). R: P6 merged. F: P7 merged.
- **From Wasim:** an AWS account for the Bedrock test (R), and OK for any paid tier (Workers Logs after its pricing
  change, Bedrock usage).
- The branch stays open across three waves; `main` merges into it after each phase lands.

## Workers

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| G1 | opus-worker (Opus 5.5, medium), sensitive: data | Backup and restore: the nightly canonical-table backup to R2, the restore script that rebuilds FTS5, the outbox kept paused after a restore until reconciled. | `app/ops/backup/**`, `app/server/ops/backup.ts` | P2 merged |
| G2 | sonnet-worker (Sonnet 5.5, medium) | Retention framework and per-brand settings; export and person-deletion script framework with a table registry every phase adds to; the health route behind a service token. | `app/ops/{retention,export,delete}/**`, `app/server/ops/{retention,health}.ts`, `app/ops/tables.ts` | P2 merged |
| R1 | sonnet-worker (Sonnet 5.5, medium) | Coverage: every P3 to P6 table in the registry, with retention defaults, export and deletion tests that prove one person's data goes and nothing else; Shopify privacy webhooks. | `app/ops/tables.ts`, `app/ops/**/tests`, `app/hub/connectors/shopify/privacy/**` | P6 merged |
| R2 | sonnet-worker (Sonnet 5.5, medium) | Monitoring signals on the health route and their tests. | `app/server/ops/health.ts`, `app/server/ops/signals/**` | P6 merged |
| R3 | opus-worker (Opus 5.5, medium), sensitive: secrets | The Bedrock switch: per-brand provider setting, the gateway and runner config for Bedrock, the eval suite run on Bedrock, the rule that a run never changes provider mid-way. | `app/server/model/bedrock/**`, `app/runner/src/run/provider*` | P6 merged; Wasim's AWS account |

The final check (F) is the orchestrator's, with the `qa-tester` gate on the readiness list.

## Orchestrator only

Migrations `0600`-`0699`, `app/server/routes.ts`, `app/wrangler.product.jsonc` (R2 lifecycle, the backup schedule),
lockfiles, `ci.yml`, `docs/runbook-backend.md`, `docs/onboarding-checklist.md`, `docs/data-map.md` (template only, no
brand), `AGENTS.md`, `verify` skill, `e2e/ship/production-readiness.spec.ts`, the restore drill and rehearsals.

## Order and parallelism

1. Wave 3: G1 and G2 in parallel beside P3's chat track (at most 2 workers).
2. Wave 5: R1, R2, R3 beside P6 (at most 3 workers; P6 takes 5).
3. Wave 6, after P7 merges and `main` merges in: the final check, then the final PR.

## Browser scenarios (`e2e/ship/production-readiness.spec.ts`, desktop and phone)

- S1: An admin sets a retention period in Settings and it shows the next cleanup.
- S2: After a member's removal, their session ends and they can't sign back in.
- S3: Pause the brand's agent from Settings; a new question is refused with a clear notice; resume.
- S4: After a restore, Approvals shows the outbox paused for reconciliation until an admin confirms.

## Acceptance

1. Retention deletes past-retention rows and files on schedule (tested with a pinned clock).
2. The export script produces a complete copy of every registered table and file; the person script deletes one
   person's data and nothing else (tested on the seeded brand).
3. The nightly backup lands in R2; a restore rebuilds the search index and keeps the outbox paused until reconciled.
4. The restore drill across D1, R2 and Durable Objects passed on the house deployment, with a record.
5. Each runbook step was rehearsed once on the house deployment, with a record.
6. The health route reports every listed signal behind a service token; no chat or customer content leaves the account.
7. Shopify's mandatory privacy webhooks are handled and tested.
8. The Bedrock switch passes the eval suite on Bedrock for the house brand; it's off by default; a run never switches
   provider.
9. The onboarding checklist and data map template exist, with no brand detail in this repo.
10. QA PASS and the ship recording on S1 to S4; the readiness list is checked item by item.

## Must not

No real brand data in a drill; no automatic provider failover; no deletion script without a dry run and a count; no
brand names, account ids or hosts in this repo; no paid tier without Wasim's OK.

## Risks

- A long-lived branch drifts; `main` merges in after every phase, and the table registry is the one place phases add
  to.
- Durable Object point-in-time recovery and D1 Time Travel restore to different moments; the drill records the gap and
  the reconcile step covers it.
- Bedrock lacks WebSearch; the evals show what changes and the switch's description says so.

## How it lands

- Branch `fleet/production-readiness` from `main` after P2 merges.
- Review rows: G1, R3 and the migrations at Sonnet plus Opus high (data, secrets); G2, R1, R2 Sonnet plus Opus medium.
- Final PR after P7 with the full ship gate and the readiness record; release to the house deployment with Wasim's OK.
