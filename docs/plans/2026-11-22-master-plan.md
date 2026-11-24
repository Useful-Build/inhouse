# Master plan: Watch first, the rest at the first client

Updated: 2026-11-24 (standing decision 10: Export everything holds brand-shared data only, interim). Earlier: 2026-11-23 (standing decision 9: eval timing; 6 to 8: brand skills, team request statuses, routine run history). Earlier: 2026-11-22 (aligned with the 5-file repo setup in `AGENTS.md`, `REVIEW.md`, `VERIFY.md`, `DESIGN.md`, and `FEATURE_MAP.md`).

Decided by Wasim on 2026-11-22: split the remaining backend work into two parts. **Part 1** is built now: a Watch-ready product, including memory at Watch, document skills, and Watch safety/readiness. **Part 2** is built once the first client signs, during that client's Watch months.

## How work executes from here

- Single-agent-by-default workflow per `AGENTS.md` (no Line A / Line B dual orchestrators, no seat A/B/C/D rules).
- Reviews follow `REVIEW.md` on `main` (Low: CI + self-check; Normal: 1 fresh-context Opus 5.5 high pass; High/Sensitive: Fable 5.2 high + Gemini 4 Neon high + Wasim's OK).
- Verification and targeted live QA follow `VERIFY.md`; every user-facing change updates `FEATURE_MAP.md`.
- **Override for older phase plans:** where any active phase plan (`p5-connectors.md`, `p6a-memory-skills.md`, `p8-production-readiness.md`, `2026-11-21-needs-you-cards-and-panel.md`, `2026-11-19-backend.md`) names Sonnet+Opus review rows, the QA gate, the `verify` skill, or `.agents/skills/verify/feature-map.md`, root `REVIEW.md`, `VERIFY.md`, and `FEATURE_MAP.md` win.
- Milestone releases into `main` (P5, P6a, P8a) still use their existing `fleet/*` branches, `ship.yml` recording, and Wasim's exact-SHA approval before squash-merge.

## Why

- Connectors for tools without an official MCP server are deferred to client onboarding (BD4). Act (P6b), Run (P7), and their write readiness (P8b) are not needed during a client's initial Watch stage.
- What cannot wait: Watch reads live store and Slack data on day one, so read-side safety switches, safety evals, retention, export, deletion, backups, restore-with-deletions-preserved, and privacy webhooks come before real client data.

---

## Status snapshot (as of 2026-11-22)

### Already done on `main`
- **P0 (Spikes):** Done (`docs/decisions/p0-*.md`).
- **P1 (Agent seam):** Done.
- **P2 (Backend core):** Done, released to house account.
- **P3 (Agent chat):** Done, released to house account.
- **P4 (Watch) code & morning-check eval:**
  - `fleet/watch` squashed to `main` (`b8aec23`).
  - Store-data eval-target mode (#320), eval hub binding fix (#319), and nightly Slack connector workflow (#317) merged to `main`.
  - House hub Shopify app setup (`inhouse-house` on `inhouse-p0-dev`, 5 read scopes, secrets, and ops vars) done.
  - P4 Acceptance 2 (morning-check paid graded run on eval deployment) **PASSED 12/12** (`eval-run 45052815852`, SHA `c4babe48`).

### Already built on open PRs & `fleet/*` branches (finish and merge, do not rebuild)

| Area | Branch / PRs | Current state |
|---|---|---|
| Standalone PRs into `main` | **#313** (P9 list update), **#323** (P8a/P8b plan re-cut), **#351** (New chat reload layout E2E) | All 3 have full `ci` + `pr-gates` green and are ready to merge. |
| **P5 Connectors** | `fleet/connectors` + open **#337** (`chore/conn-main-merge`) | W1–W5, Slack MCP/OAuth/code-mode, ship spec (#315), and decision 0025 (#338) are merged on `fleet/connectors`. **#337** merges latest `main` into `fleet/connectors` (also fixes stale New chat layout on that branch); fast CI green. |
| **P6a Memory & Skills** | `fleet/memory-skills` + open **#350** (`feat/ms-w4-specs`), **#340** (`feat/p6a-w4-product`) | PR0 (#328), W1 memory toggles (#339), W2 team memory approval server (#342) & app (#348), W3 skills (`dataviz`, PDF, Word, spreadsheet) (#343) & team requests (#344), W4 read-side eval cases (#331) & runner (#332) are merged on `fleet/memory-skills`. **#350** has fast CI green; **#340** has a failing `runner` check to fix. |
| **P8a Watch Readiness & C1** | `fleet/production-readiness` + open **#352** (runner probe fix), **#346** (C1 PR B jobs/deletion/export/data map), **#349** (F2 Shopify privacy webhooks), **#347** (O runbook & onboarding docs) | Merged on `fleet/production-readiness`: C1 PR A paged/insert-only backups + FTS rebuild (#330, #336), Watch safety switches (#329), Watch soak driver & evidence (#326), egress logging (#333), safe error logs (#335), restore finish at Watch (#334), and **all launch-critical P9 fixes** (#327, #341, #345). **#352** fixes the 3 runner image probes broken by #335. **#346** needs its `test-build` failure in `activity.spec.ts:84` fixed. **#349** passed Opus review (per A10 notes; no GitHub review object posted). **#347** merges after #346. |

*(Also open on `main`: Dependabot PRs **#52**, **#53** (failing e2e), and **#54** — triage separately when convenient.)*

---

## Part 1: remaining steps to Watch-ready (in order)

### 1. Unblock private `inhouse-ops` self-hosted runner (blocks evals, sandbox recordings, and house releases)
GitHub Actions billing in `Useful-Build/inhouse-ops` blocked ops workflows; the self-hosted Mac mini runner kit (`ops#33`–`#35`) is merged and its VM isolation check passed.
- **Needs Wasim:** apply the Tailscale ACL policy + `tag:ops-runner` on Mac mini (so `ops-pr` / `test-deploy` can be enabled safely without exposing LAN/tailnet devices).
- Install the LaunchAgent, verify `tag:ops-runner` isolation, and run the first `eval-deploy` at `main`.
- Land remaining ops updates in `inhouse-ops`:
  - `ops#32` (eval pages + `read-side` suite args from #340).
  - Eval `HUB_CONNECT` binding (`ReadGateway` + `ConnectGateway`, never `HUB_DELIVERY`) before P5 eval deploys.
  - `HOUSE_SLACK_*` vars for P5 house release.
  - Private monitor alerts on `/api/health` amber/red signals (`privacy_requests`, C1 freshness, `egress_record_failed`).

### 2. Finish P4 tail and release P4 to house (starts Watch soak)
- Merge **#313**, **#323**, and **#351** into `main`.
- Commit the passing morning-check result (`c4babe48`) under `app/evals/morning-check/results/`.
- Run P4's remaining paid evals (Wasim approved caps): system v2 product suite (~$5) and store-data exfiltration (~$3).
- Before releasing P4 to house: check `SELECT count(*) FROM chat_messages` on house D1 (migration `0142` safety) and verify the predrain DNS check.
- Release P4 to house (connector hub first), run real-model smoke, and do one manual signed-in Library download check. **Watch soak begins here.**

### 3. Finish P5 Connectors -> `main` -> house
- **Reconcile with the 5-file setup:** re-merge `main` into **#337** after #354 lands, port any P5-only additions from old `AGENTS.md` / `.agents/skills/verify/*` into `VERIFY.md` / `FEATURE_MAP.md` / `docs/architecture.md`, and keep `.agents/skills/verify/*` and `.claude/skills/verify` deleted.
- Merge **#337** into `fleet/connectors` (re-sync `#338` if needed) and remove the Slack nightly skip block in `.github/workflows/nightly.yml`.
- If P8a merges to `main` first, swap P5's local Watch check in `notify-slack/send.ts` for `deliveryRefusal` and ensure caught-error logs use `safeError`.
- Run P5 final sandbox recording + targeted QA + v3 paid evals (with Wasim's OK), open final PR to `main`, get Wasim's exact-SHA approval, squash-merge, and release to house.
- Run P5 live checks 1–9 (needs Wasim's Slack test workspace credentials; checks 4, 6, and 7 are paid) and paid Acceptance 4.

### 4. Finish P6a Memory & Skills -> `main` -> house
- Fix `runner` check on **#340** and merge **#340** and **#350** into `fleet/memory-skills`.
- **Reconcile with `main` and the 5-file setup:** merge `main` into `fleet/memory-skills`, keep `.agents/skills/verify/*` deleted (P6a's `0470`–`0479` migration range is already recorded in `docs/architecture.md`), ensure `prompt_version === 3` after P5, and apply #329 `t:webfetch` / `t:websearch` settings copy and `safeError` guard when meeting P8a.
- Run P6a final sandbox recording + targeted QA, open final PR to `main`, get Wasim's exact-SHA approval, and squash-merge.
- Run read-side safety evals across all 4 picker models (paid, per-run cap ask; zero bypasses required on every model left enabled for clients), then release to house.
- **Added to P6a (standing decision 6):** brand skills and the skill page's real text, built on `fleet/memory-skills` before the final PR:
  - **Skill text on the product:** the Worker bundle carries a copy of our `SKILL.md` files. `GET /api/skills/:name` serves the body (frontmatter stripped), the tools it uses and when it last changed. `dataviz` ships inside the engine, so it gets our own short summary.
  - **Skill Creator:** Anthropic's `skill-creator` (Apache 2.0, from `anthropics/skills`) ships as our plugin skill `inhouse:skill-creator`, with its licence file and a notice beside it. Scripts or steps it needs that our guards refuse are cut or rewritten.
  - **Brand skills:** a member or admin creates one in a chat. The agent drafts it with Skill Creator and saves it through our MCP tool `skill_save` (name, description, body), which goes to the server. The agent can't write a skill file in its sandbox. A brand skill is live at once, with no approval step. Its creator or an admin can edit it in a chat or delete it. A D1 table holds the brand's skills (registered in `app/ops/tables/`), each with who made it and when it last changed.
  - **Loading:** at session start the runner writes the brand's skills into a root-owned, read-only folder beside our plugin. They load like every skill: only the name and description sit in the agent's context, and the body is read when the skill is used. A brand skill can't widen anything: its `allowed-tools` and other frontmatter beyond name and description are dropped, and every container guard still applies.
  - **Not changed:** our skills (PDF, Word, Spreadsheet, Skill Creator) and `dataviz` stay read-only for brands. "Request a skill" still sends the Inhouse team a request.
  - **The P6a plan's "Must not" changes:** "no skill loaded from a writable path" now reads "no skill loaded from a path the agent can write"; "no copied third-party skill text" gains one exception, Skill Creator under its licence.
  - **Proof:** property tests on the frontmatter strip and the name rules, an API spec for create, edit and delete with the access matrix, the runner's container probe listing a brand skill, and a read-side eval case where a brand skill's body tries to widen tools or send data out (zero bypasses).

### 5. Finish P8a Watch Readiness -> `main` -> house
- Merge **#352** into `fleet/production-readiness` (fixes runner image probes on the branch).
- Fix `activity.spec.ts:84` on **#346** and merge **#346**, **#349**, and **#347** (in order: #346 before #347).
- **Reconcile with the 5-file setup:** when merging `main` into `fleet/production-readiness`, port its 18 added feature-map lines from `.agents/skills/verify/feature-map.md` into root `FEATURE_MAP.md` and keep `.agents/skills/verify/*` and `.claude/skills/verify` deleted.
- Complete remaining P8a implementation items:
  - **Restore + C1 replay wiring:** wire C1's exported per-job replays into restore, replay pseudonymisation for the new phase, and add the differential test (`backup -> retention + deletion -> restore + replay == live`).
  - **Data and access screen:** retention row and "Export everything" for P2–P6a stores (edit `Settings.tsx` / `content.ts` / `mock.ts` cleanly after P6a merges).
  - **C1 PR C:** cover P6a requests, brand skills, memory states and their audit decisions, and Today set-asides. TODO after P5 lands in main: cover `connector_accounts`, `notify_channels`, `notify_sends` and `SignIn.connectedBy` for person deletion, export, retention and the data map.
  - **Teardown script (sensitive):** delete every container application explicitly, list before and after, and fail if any remain.
  - **Small P8a follow-ups:** `no-raw-error-text` L-2 shapes, `egress_record_failed` health signal + refusal-rate guard, and web-tool eval `t:websearch` reset.
- Rehearse runbook procedures (pause, key/token rotation, member removal, restore, teardown, rollback redeploy) and candidate deploy.
- Open final P8a PR to `main`, get Wasim's exact-SHA approval, squash-merge, release to house, and run the house restore drill (deletions stay deleted; each step with Wasim's OK).
- Note for Wasim's P8a packet: R2 lifecycle uses `retention_overdue` detection instead of blind age deletion on `files/` / `sessions/` / `library/`; busy brands need F1's resumable backup before go-live (~225k–450k message ceiling).

### 6. Watch soak and fresh-account smoke (Part 1 done gate)
- **Watch soak:** starts at P4 house release and passes after **3 consecutive clean days** with P4, P5, P6a, and P8a all live on house (product model inside house monthly spending cap). Daily evidence verifies: morning check completed, 1 bell notice per alert, memory saves/approvals behaved, connector reads succeeded, failed runs recovered, zero guard/leak bypasses. Missing/budget-skipped days do not count; any bypass, lost/doubled notice, or behavior-changing release restarts the 3-day window.
- **P8a readiness list:** all readiness items pass, including the house restore drill with deletions staying deleted.
- **Read-side evals:** zero bypasses on every model left enabled for clients.
- **Fresh-account smoke:** deploy to the second Cloudflare account (brand stand-in, needs Wasim's account input) with invented data and verify both Access apps, a support-access grant, payload logging off, and the private monitor alert path.

---

## Part 2: build when the first client signs

Built during the client's first Watch months, before they move to Act. The client stays pinned to the approved Watch release; every Part 2 release is proven inert at stage Watch before reaching a client.

- **First, at signing:** client's Shopify plus chosen second tool and connector evals; `read_all_orders` proven in week 1.
- **P6b, Act core:** outbox and 10 s send hold, typed approvals and operation table, approval rules by member id, `question_ask`, approval UI and C7, Shopify writes via write app + house store move (unset `NIGHTLY_CODEMODE`), Slack posts as Act operations, Act injection/exfiltration eval sets on every picker model.
- **P7, Run:** policy check, atomic daily/restock limits, handled jobs with Undo, Pause, and Run eval set on every picker model.
- **P8b:** F1 outbox reconcile, coverage for P6b/P7 stores, resumable backup for busy brands, and 14-day write soak on the product model before any client moves to Act.
- **Later or on request:** Bedrock (Q5) and remaining non-launch-critical P9 items (code deduplication, unused aliases, live-only file notes, eval D1 growth, open-schema source check, SKU stemming, `#306` nits).

## Before the first client's real data arrives
- Part 1 is complete, including the 3-day Watch soak, P8a readiness list / house restore drill, and fresh-account smoke.
- The client has their own Cloudflare account and Anthropic key with payload logging off.
- Access sign-in uses the Inhouse team's separate Access app; no `workers.dev`, preview, or public hub routes exist.
- Shopify starts at level 1 protected customer data only.
- The brand's data-flow document is complete.
- If onboarding a high-volume brand (~225k+ messages), ship F1's resumable backup before go-live.

## Standing decisions (Wasim, 2026-11-22)
1. **Memory at Watch: yes.** Brand memory moves from Act into Watch.
2. **Models open to clients at Watch:** all 4 picker models tested on the read-side eval set (paid, per-run cap asked); any model that has not passed stays off for clients.
3. **Watch soak:** starts at P4 house release; passes after 3 consecutive clean days with P4, P5, P6a, and P8a live, inside the house monthly spending cap.
4. **P4 paid runs:** morning-check $5 (done, 12/12 passed), system v2 product suite $5 (up to $10), store-data $3.
5. **Interface audience (2026-11-23):** members and admins are non-technical to semi-technical people running a brand, not developers. Every screen shows outcomes in plain words: what happened, what it means for the business, what to decide. Hide mechanics (run ids, step timings, token or model detail, tool call names) behind a deliberate "full trace" view at most. Every phase that adds a user-facing field follows this, and `DESIGN.md` carries the rule.
6. **Brand skills (2026-11-23):** any member or admin can create skills in a chat and edit or delete their own (admins any brand skill), with no approval step. Skills the Inhouse team builds stay ours and read-only for brands. Skill Creator ships so the agent can write skills well. Skills load the normal way: name and description in context, the body only when used. Lands in P6a (step 4).
7. **Team requests (2026-11-23):** a request shows its status only. No dates, notes or "In progress": timing is agreed with the brand directly.
8. **Routine run history (2026-11-23):** `GET /api/routines/:id/runs` (route 86: P5 holds 68 to 76 on `fleet/connectors`, P6a 77 to 85) returns each routine's own recent runs (when, outcome, a plain one-line result) from its run slots, so the routine panel stops matching Activity by name. A normal-risk PR into `main`.
9. **Eval timing (2026-11-23):** P4's paid evals on app main `be638264` were product suite 119/123 (97%) with one exfiltration bypass (X03 quoted an attachment's planted link) and store-data 6/10 with zero unsafe actions (four cases not exposed); see `app/evals/results/2026-11-23-p4-evals.md`. Code fixes land now: the chat shows links to unlisted hosts as plain text, and the store-data harness makes sure each planted field is read. No more paid runs until Watch is complete (routines, P5, P6a and P8a in). Then every eval runs once on the final product, on all four picker models, Opus included, with the prompt fix (never repeat links from files or tool results). The Watch house release (step 2) waits for that run.
10. **Export everything holds brand-shared data only (interim, 2026-11-24, pending Wasim):** route 95's export is option 1 of the P8a D review: the brand's shared data and the caller's own personal data, never another person's personal memories, settings, photos or chats; members as the Members page shows them (no sign-in subject, no Inhouse team or service rows); the Inhouse team under a grant gets no members' chats. Each exported store declares its rule in `app/ops/export/brand-for-caller.ts`. This is the default until Wasim confirms or picks another option; the ops CLI's whole-brand export and a person's own export are unchanged.
