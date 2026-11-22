# Master plan: Watch first, the rest at the first client (final, 2026-11-22)

Decided by Wasim on 2026-11-22: split the remaining backend work into two parts. **Part 1** is built now: a Watch-ready
product, including the memory capability and our own tools useful for Watch. **Part 2** is built once the
first client signs, during that client's Watch months.

Inputs:
- Second opinions from GPT-6.2 Sol xhigh, Gemini 4 Neon XHigh and Fable 5.2 xhigh. All their must-fixes are folded in
  below.

## Why
- Connectors for tools without an official MCP server were already deferred to onboarding (BD4). The real saving is
  Act (P6 core), Run (P7) and their readiness work, which no client needs at Watch.
- What can't wait: Watch reads live store and Slack data on day one. Its safety tests and switches, and the data duties
  (retention, export, deletion, backups, a restore that keeps deletions deleted, privacy webhooks), come before real
  client data.

## Part 1: build now

### Line B (B2): P4 rest, P5, P6a, P8 C1
P6a and C1 need only P4, so they start now, alongside P5. P5's tail waits on Wasim's Slack credentials anyway.

1. **P4 rest.**
   - The store-data eval-target mode (#320), then its paid run.
   - The house release, hub first. The 0142 row count and the predrain DNS fix land before it.
   - The real-model smoke, and one hand check of a signed-in Library download.
2. **P5 complete.**
   - The Tools page crash fix.
   - Ship spec #315, its recording and QA.
   - The decision record superseding 0006.
   - The main merge: system prompt v3 per A9's plan, and hub/index carrying P4's test shop through code mode.
   - Final PR, Wasim's exact-SHA approval, house release.
   - Live checks 1 to 9, which need Wasim's Slack test workspace and credentials.
   - Paid runs with Wasim's OK: acceptance 4 and live checks 4, 6 and 7.
3. **P6a, memory and skills** (cut from P6, its own branch and ship gate):
   - **Memory at Watch** (Wasim: yes).
     - Unlock `m:learn`, Team memory and `m:ask` at Watch in `settings/content.ts`.
     - Make the server honour both toggles. Today none reads them, so "Learn from my chats" off still saves facts.
       This takes over the P9 Memory toggles item.
     - Team memory approval: a brand fact waits as `waiting` (the status already exists in `memories`) until an admin
       approves or rejects that exact revision, audited. Its own small worker, kept separate from C7 and the outbox. Tests
       prove an edit or a restore can't skip approval.
     - A shape that P6b can extend later, with no rework.
   - **Skills.** `dataviz`, PDF, Word and spreadsheet through `plugins`, from a read-only path (Q7, decided
     2026-11-19). The Skills page lists them.
   - **Team requests.** The Tools page "Request" button toasts "Request sent" while `requestTool` is refused
     (`Tools.tsx:150`). Ship `team_request_create` and `team_request_list` with the Skills page's "request a skill" in
     P6a, so the button works. They're small and need no outbox.
   - **Read-side safety evals,** defined by where data could leave: a WebFetch URL, `memory_save`,
     `notification_send`, files. Injection and exfiltration cases on what Watch reads (Shopify, Slack, tool results,
     web pages). Zero bypasses on every model left on for clients (decision 2).
4. **P8 C1.**
   - Coverage for the P2 to P6a stores, including memory records and their states, run events and transcripts.
   - The FTS rebuild on restore.
   - Jobs registered as scheduler handlers, the R2 lifecycle rules, the data map template.
- **File owners.** `Settings.tsx`, `settings/content.ts` and `mock.ts` get one owner at a time. B2 owns them during
  P6a, and A9's Data and access work goes in after P6a merges, or B2 hands over in writing.

### Line A (A9): P4 paid run, P8a, launch-critical P9
1. **P4.** #319 and the eval-deploy, then the paid graded run (morning check plus system v2, Wasim's cap OK), then
   support for line B's house release.
2. **P8a, Watch readiness** (cut from P8). Launch-critical P9 folds in here, so it has a branch and a gate.
   - Merge main into `fleet/production-readiness`.
   - **A restore that can finish at Watch.** Move from F1 into P8a: the audit-log re-append, the deletion-log replay
     and the admin confirm. Prove across D1, R2 and Durable Objects that deleted data stays gone. Only the outbox hold
     and the tool check stay in P8b. Today a restore ends `restored_unreconciled` (`app/ops/backup/restore.ts`).
   - **The Data and access screen.** The retention row and "Export everything" for the P2 to P6a stores.
   - **F2, Shopify's privacy webhooks.** Check the docs first. Build them if they apply or it stays unclear.
   - **Server-side safety switches for Watch.**
     - A WebSearch off switch (none exists).
     - A WebFetch allowlist that's empty by default (today an empty `t:webfetch` means any public host).
     - Bell-only delivery and no external writes, enforced at stage Watch.
     - Web tools stay off for clients until their eval cases pass.
   - **Runbook and onboarding.**
     - The runbook: pause a brand, rotate the model key and tool tokens, remove a member, restore, teardown, redeploy
       the previous release. Each step rehearsed once.
     - The onboarding checklist.
     - Teardown that leaves no container application behind.
   - **The Watch soak driver and evidence query.** Moved from P7 W3. They replace `INHOUSE_HOUSE_SOAK`, which only
     works on P6's outbox, so it's dropped from Part 1.
   - **Launch-critical P9.**
     - The 0142 count and the predrain fix, before line B's P4 house release.
     - The Inhouse-team sign-in loop (`wrong_kind`).
     - Today showing no failed-check card before 06:10.
     - The empty chat saying "No tools connected" while the composer disagrees.
     - `err.message` logging, fixed or proven safe before client data.
     - Loading-flash and stale-retry-card fixes only if QA shows they block a core flow. Otherwise they go to Part 2.
     - Line B may mark one of its lows launch-critical, with a reason.
   - **Release order.**
     - P8a's code reaches the house mid-soak, so its retention and backup jobs run there.
     - The candidate rehearsal follows, then the final PR and Wasim's exact-SHA approval.
     - The house restore drill runs last, from the approved head, each step with Wasim's OK.
3. **#313.** Merge as planned. The P9 list stays the one record.

### The Watch soak
- **Start.** It starts at P4's house release, at stage Watch, and each later release adds to what's checked.
- **Gate.** It passes after 3 consecutive clean days with P4, P5, P6a and P8a all live (decision 3).
- **Daily evidence.** The driver and the evidence query check, every day:
  - the morning check completed;
  - exactly one bell notice per alert;
  - memory saves and approvals behaved;
  - connector reads succeeded;
  - failed runs recovered;
  - no guard or leak bypass.
- **What doesn't count.** A missing or budget-skipped check doesn't count as clean.
- **Restarts.** A bypass or a lost or doubled notice restarts the count. A release that changes behaviour restarts the
  3-day window.
- **Model and spend.** It runs on the product model with a spend limit, per Q8, inside the house's monthly spending cap.

### Part 1 is done when
- The house runs P4, P5, P6a and P8a, and the Watch soak passed.
- The P8a readiness list passes, including the house restore drill, with deletions staying deleted.
- The read-side evals show zero bypasses on every model left on for clients.
- A fresh deploy to the second account (the brand stand-in, decision 2026-11-20) passes a smoke test with invented
  data. That includes:
  - both Access apps and a support-access grant;
  - payload logging off;
  - the private monitor's alert path exercised.

### Order and estimate
- **Line B.** P4 rest now. P5, P6a and C1 in parallel, about 5 to 6 working days.
- **Line A.** The P4 paid run now. P8a in parallel, about 5 to 6 working days, now that the soak driver and the restore
  steps moved in.
- **Elapsed.** About 8 to 10 working days, since the soak runs alongside the build.
- **What can stretch it.** Wasim's Slack credentials, paid-run OKs and approvals.

## Part 2: build when the first client signs
Built during the client's first Watch months, before they move to Act. The client's
deployment stays pinned to the approved Watch release. Every Part 2 release is proven inert at stage Watch before it
reaches a client. A client moves stage only by an explicit promotion after that stage's gates pass.

- **First, at signing.**
  - The client's Shopify plus their chosen second tool, and their connector evals.
  - `read_all_orders` proven in week 1.
  - This comes before any Act work.
- **P6b, Act core.**
  - The outbox and the send hold.
  - Typed approvals and the operation table.
  - Approval rules by member id.
  - `question_ask`.
  - The approval UI and C7.
  - Shopify writes through the write app, and the house store move (unset `NIGHTLY_CODEMODE` then).
  - Slack posts as Act operations.
  - Act's injection and exfiltration sets, on every model in the picker (Q6).
- **P7, Run.** All of it, as locked (rev 1.2), plus its Run eval set on every model (Q6).
- **P8b.**
  - F1's outbox reconcile, and coverage for the P6b and P7 stores.
  - The 14-day write soak on the product model (Q8), before any client goes to Act.
- **Later or on request.**
  - Bedrock (Q5).
  - The rest of P9: duplication, aliases, live-only file notes, phone QA shots, eval D1 growth, open-schema source, SKU
    stemming and #306's nits.
- **Size.** Roughly 2 to 3 weeks of agent time plus the 14-day soak, inside the client's first Watch months. To be
  re-estimated at signing.

## Before the first client's real data arrives
- Part 1 is done, including the fresh-account smoke.
- The client has their own Cloudflare account and an Anthropic key with payload logging off.
- Access sign-in uses the Inhouse team's separate app. There are no workers.dev, preview or public hub routes.
- Shopify is at level 1 only.
- The data-flow document is done.

## Wasim's decisions (2026-11-22, "yes." to all four; 1 "agree.", 2 changed to "all 4 models.", 3 "ok.")
1. **Memory at Watch: yes.** Memory of the brand moves from Act into Watch. The Stages row in the decision log changes.
2. **Models open to clients at Watch** ("all 4 models."): the read-side set runs on all four models in the picker
   (paid, cap asked per run). A model that hasn't passed stays off for clients.
3. **The soak:** starts at P4's house release and passes after 3 consecutive clean days with P4, P5, P6a and P8a live,
   on the product model with a spend limit (Q8), inside the house's monthly spending cap.
4. **The store-data paid run** (P4 acceptance 10): OK, with a small cap set by Wasim.

## Doc changes once this is final
- Line A lands this plan in `docs/plans/` as a docs-only PR. It updates the phase table in `2026-11-19-backend.md`:
  P6 splits into P6a and P6b, P8 into P8a and P8b, P7 is parked and P9 is split.
- The decision log (private repo) is updated with Wasim's answers to decisions 1 to 3, the Part 1 and Part 2 split, and the
  soak change.
- Each line re-cuts its own phase plan: B2 for P6a and P6b, A9 for P8a and P8b. Each gets one Sonnet review.
