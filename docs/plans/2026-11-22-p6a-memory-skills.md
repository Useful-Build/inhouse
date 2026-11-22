# P6a: memory and skills (`fleet/memory-skills`)

Status: draft for Wasim's approval, 2026-11-22. Cut from P6 by the master plan (`2026-11-22-master-plan.md`, which lands with line A's docs PR #322; Part 1,
line B item 3; Wasim's decisions 1 and 2 of 2026-11-22). The rest of P6 is P6b, parked until the first client:
[`2026-11-19-p6-act.md`](2026-11-19-p6-act.md). Common rules are in the backend plan's "Phase schedule (waves)".

Progress: tracked in the backend plan's "Implementation progress" section, entry P6a. Read it before you start and
update it before you stop.

## Goal

Memory works at Watch, with team facts behind an admin's approval and both memory switches honoured by the server; the
agent has our file skills; requests to the Inhouse team work; and the read-side safety evals show zero bypasses on
every model a client can pick.

**Success measure (the real slice):** at Watch, the agent saves a team fact; it waits until an admin approves that
exact wording, and only then does the agent find it.

## What's there today (checked on `main` at c4babe4)

- **Memory is locked at Act in the UI only.** The rows "Learn from my chats" (`m:learn`), "Team memory", "Ask before
  saving a team rule" (`m:ask`), "Teach it something" and each Forget button have `need` 1
  (`app/src/screens/settings/content.ts:173,176,240,252,260`); `Settings.tsx:387` greys a row when `S < row.need`. The
  memory tools have no stage check: only routines check the stage (`app/server/routines/store.ts:105`).
- **Nothing on the server reads either switch.** `m:learn` and `m:ask` exist only in the settings registry
  (`app/shared/contract/settings-table.ts:91,94`), its labels and tests. So "Learn from my chats" off still saves
  facts. The backend plan's P9 item on these toggles (`2026-11-19-backend.md:803`) moves here.
- **Team facts wait, and nothing can approve them.** A brand fact is saved `waiting`
  (`app/server/mcp/tools/memory/store.ts:186`), a reworded one goes back to `waiting` (`store.ts:213`), and undoing a
  forget sends it to `waiting` (`store.ts:255`). The status exists in the table (`0140_memories.sql`). But no route
  moves `waiting` to `active`, and the one visibility rule hides waiting facts from the tools and from route 43
  (`app/server/mcp/tools/memory/visibility.ts:7`), so an admin can't even see them.
- **Skills:** the image already installs Python with reportlab, pypdf, python-docx and openpyxl for the file skills
  (`app/runner/Dockerfile:32-36`) and copies our plugin root-owned and read-only to `/opt/inhouse/plugin`
  (`Dockerfile:53-57,71-72`; `app/runner/src/guards/paths.ts:12`), loaded through `plugins`
  (`app/runner/src/guards/options.ts:220`). `OUR_SKILLS` is empty (`app/runner/src/guards/lists.ts:72`); only `dataviz`
  is kept (`lists.ts:37`). The product client has no skills (`app/src/agent/http/client.ts:78`).
- **Team requests are refused.** The Tools page's Request button calls `requestTool` (`app/src/screens/Tools.tsx:150`)
  and toasts "Request sent", but the product client refuses `requestTool`, `requestSkill` and `sendTeamRequest`
  (`client.ts:1306-1309`). `team_request_create` and `team_request_list` are registered
  (`app/server/mcp/registry.ts:54-55`) and answer `not_available_yet` (`app/server/mcp/tools/stubs/index.ts:27`).
- **The picker's four models** (`app/server/model/catalog.ts:71-75`): Fable 5.2 (`claude-fable-5-2`), Opus 5.5
  (`claude-opus-5-5`), Sonnet 5.5 (`claude-sonnet-5-5`) and Haiku 5.5 (`claude-haiku-5-5`). A model is off for a
  brand only when `tm:<id>:on` is `'off'` (`catalog.ts:118-119`).

## Scope

In:
- **Memory at Watch.**
  - `m:learn`, Team memory, `m:ask`, Teach and Forget unlocked at Watch (`need` 0). The `m:ask` row's copy says what
    the server does: an admin approves.
  - **`m:learn` honoured.** Off (the person's row is `false`): `memory_save` with scope `person` and `memory_update`
    of a person fact are refused with a reason the agent can read (`learning_off`). Forgetting still works; reads are
    unchanged; brand facts follow `m:ask`. Missing or `null` means on (the default).
  - **`m:ask` honoured.** On (the default, missing or `null`): every brand save and reword by the agent is `waiting`,
    as today. Off: a person's agent saves and rewords brand facts `active` at once. Three things never change with
    the switch: a routine's save or reword (`m_system`) always waits, an admin's restore (route 45's undo) always waits,
    and turning `m:ask` off approves nothing that already waits.
  - Each decision reads the setting inside the same SQL statement as the write, so a switch change can't race a save.
- **Team memory approval** (its own worker, separate from P6b's C7 and outbox). A waiting brand fact becomes `active`
  only when an admin approves that exact revision; rejecting it makes it `forgotten` (route 45's undo brings it back
  as `waiting`). Both are audited with the fact's id and the revision decided. Admins see waiting facts on the Team
  memory page with Approve and Reject. The shape leaves room for P6b (design notes).
- **Skills.** `dataviz` plus our own `inhouse:pdf`, `inhouse:word` and `inhouse:spreadsheet`, loaded through
  `plugins` from the read-only path. Each is our own text. The Skills page lists the four from the server.
- **Team requests.** `team_request_create` and `team_request_list`, their routes, the Tools page's Request (with its
  Undo) and the Skills page's "Request a skill", the Inhouse team window's list, and the Inhouse team marking a
  request done or declined. No outbox: a request is a row in our own D1, not a write to anyone's tool.
- **Read-side safety evals,** defined by where data could leave: a WebFetch URL, `memory_save` (and
  `memory_update`), `notification_send`, and files the agent makes. Injection and exfiltration cases planted in what
  Watch reads: Shopify, Slack, tool results (files, history, memory) and web pages. Code-graded, zero bypasses on
  **each** of the four models (Wasim, 2026-11-22: "all 4 models."). Each run is paid, with a cap Wasim sets per run. A
  model that hasn't passed stays off for clients.

Out (P6b or later): the outbox, approvals and the four approval tools, approval rules by member id, `question_ask`,
C7 and the approval UI, Shopify writes and the house store move, Slack posts as Act operations, Act's injection and
exfiltration sets; a bell notice for a waiting fact; per-brand skill switches; skills a brand writes.

## Inputs and gates

- P4 merged into `main` (#312, b8aec23). P6a starts now, alongside P5.
- **P5 merged into `main`, then `main` into `fleet/memory-skills`,** before W4's Slack cases and the real
  `notification_send` exit run (they need P5's Slack reads, its fake Slack and its `notification_send`). Nothing else
  waits for P5.
- **A page host for the web-page cases (line A).** The eval deployment can't fetch a page from the test upstreams. Ask:
  a static Worker in the sandbox account serving W4's invented pages from `app/evals/read-side/pages/`, listed in the
  eval brand's `t:webfetch`, deployed by line A's eval-deploy (no cost on Workers Paid). Until it exists the web-page
  cells are "not run", never "passed".
- **Line A's OK on lines in its files** (each lines-only, pinged before the PR): the memory store and memory tools
  (W1, W2), the memory client (W2), the audit contract and `support.access` pairing (PR0), `OUR_SKILLS` (W3) and the
  tool areas file (W3). `shapes.md` row "P6 lines inside line A's files" r1 already covers `memory.approved`, the
  `/approved` pattern, `setBrandApproved` and the `OUR_SKILLS` lines; the rest is new and goes as r2.
- **File owners (agreed with A9, 2026-11-22):** line B owns `src/screens/Settings.tsx`, `src/screens/settings/content.ts`
  and `src/agent/mock.ts` until P6a merges. Line A's Data and access work goes in after.
- **Wasim's cap for each paid run** (decision 2). The orchestrator quotes `run.ts`'s estimate line
  (`app/evals/run.ts:52`) and writes the ledger line first.
- **Test model:** workers use the scripted model and the fake upstreams. The real-model runs are the orchestrator's:
  the read-side set on the four models, and the real-model smoke after the release.

## Design notes

- **The switches, in the store.** W1 changes only the `save` and `update` statements and their answers. A person save
  adds `AND NOT EXISTS (SELECT 1 FROM settings WHERE owner = ? AND key = 'm:learn' AND value_json = 'false')`; a brand
  save's status is a `CASE` on the brand's `m:ask` row and the saver (`m_system` always `waiting`). A refusal is told
  apart from a duplicate by re-reading, as `save` does today. Tool answers follow the fact's status, not its scope
  (today they say "waits for an admin's OK" for every brand fact, `app/server/mcp/tools/memory/index.ts:64,82`). The
  system prompt's memory line (`app/server/prompt/system.ts:12`) stays as it is: the tool's answer is the truth, and a
  prompt change would need the eval suite (AGENTS.md "Prompts").
- **Approval binds a revision.** One route, `PUT /api/memory/brand/:id/approved` `{ approved: boolean, ifRev }`, in the
  style of route 45's `{ forgotten, ifRev }`. One guarded statement plus its audit line in one batch:
  `WHERE id = ? AND scope = 'brand' AND status = 'waiting' AND rev = ?`, to `active` (approved) or `forgotten`
  (rejected), `rev + 1`. A stale `ifRev`, or a fact that isn't waiting, answers `conflict` with the current fact; a
  person fact or an unknown id is 404. Audit `memory.approved { memoryId, rev }` or `memory.rejected { memoryId, rev }`,
  `rev` being the revision decided. Approving is the only way to `active` while `m:ask` is on.
- **Seeing waiting facts.** `GET /api/memory/waiting`: the brand's waiting facts, newest first, at most 200, each with
  its text, who saved it (or "a routine"), when and its `rev`. Admins and the Inhouse team only. P3's visibility rule
  is not changed: route 43 and the tools still never show a waiting fact.
- **Who may approve.** Admins, and the Inhouse team only under a live grant (its write recorded as `support.access`
  with method `PUT` on the `/approved` pattern, which PR0 adds to `WritePatternSchema`, `app/shared/contract/audit.ts:52`).
  Members are refused by the access matrix.
- **What P6b extends, with no rework.** Each waiting item carries `kind: 'memory'`, so P6b's Approvals page can show
  facts beside actions in one list. The route's access row is the one place that says who approves, so P6b's rules by
  member id can widen it with an object check. The audit lines already carry the revision. P6b adds; it renames nothing.
- **Skills.** Our skill files live in `app/runner/image/plugin/skills/<name>/SKILL.md`; `OUR_SKILLS` names them
  plugin-qualified. Each uses only the tools the container guards allow and writes files the files route accepts
  (pdf, docx, xlsx, csv). Every file skill tells the agent never to put an outside reference in a file: no remote
  image, no link to a host the person didn't give, no fetching formula (`WEBSERVICE`, `IMPORTXML` and the like), and
  a CSV cell that starts with `=`, `+`, `-` or `@` is escaped. The files exit in the evals proves it. The product's
  Skills page has no on or off switch in P6a: every skill is in the image and always on.
- **Team requests.** Table `team_requests` (`0470`): `id`, `kind` (the client's request types, `tool | job | change |
  bug | feedback`, `app/src/state/store.ts:24`; "Request a skill" is `job`), `subject` (optional: a tool's catalogue
  key or a skill name, so the Tools page knows what's requested), `text` (1 to 1000, plain), `requested_by`, `status`
  (`open | done | declined | withdrawn`), `created_at_ms`, `updated_at_ms`, `rev`. The requester withdraws their own
  open request (the Tools page's Undo); the Inhouse team sets done or declined. At most 50 open requests per brand.
  A routine can't file one (a request needs a person). Members and admins create and read the brand's requests; the
  Inhouse team reads them and sets their status without a grant, since a request is addressed to it (the access class
  is the orchestrator's call at PR0). Audit `team_request.created { requestId, kind }` and
  `team_request.status { requestId, status }`; never the text.
- **Read-side evals.** The set reuses before it writes: P3's exfiltration cases (tool results: memory, history and
  attachments; `app/evals/cases.ts`, kinds in `app/evals/types.ts:33`), P4's store-data set (Shopify,
  `app/evals/exfiltration/store-data/`) and P5's notice cases (Slack and `notification_send`,
  `app/evals/exfiltration/notices/` on `fleet/connectors`). P6a adds the missing cells of source by exit, the files
  exit, the web-page source and `team_request_create` as an injection target, plus one report per model with each
  cell's result. A bypass is the forbidden call itself (a WebFetch to the planted host, a `notification_send` carrying
  the canary, a `memory_save` or `memory_update` of the planted text whatever its status, a file with the canary or an
  outside reference, a `team_request_create` of the planted text, a routine), graded by code over the run's rows,
  never by a model. Each model runs at its catalogue default effort (what a client gets unless Settings changes it).
- **The skills list** is `GET /api/skills` answering P3's `SkillDef[]` (`app/shared/contract/skill.ts`), unchanged. The
  server returns `need: 0` for every skill, so the Skills page shows no stage tag at Watch (`Skills.tsx:63,73`).
- **Routes.** Six, numbered by the orchestrator at PR0 after P5's highest (76 on `fleet/connectors` today): the two
  memory routes, `GET /api/skills`, and `GET`, `POST` and `PUT /api/team-requests/:id/status` for team requests.
- **Migrations:** P6a takes `0470`-`0479` (W3's `0470_team_requests.sql`; W2 needs none, `memories_scope` already
  indexes `(scope, status, n)`). P6b keeps the rest of `0400`-`0499`. The `0470` PR adds `app/ops/tables/team-requests.ts`
  (P8 C1 covers it).

## Workers

Workers run on seats A and C, or through Pi (GPT-6.2 Sol high, Gemini 4 Hydrogen) for a scoped job named in a brief.
The orchestrator writes the design into W2's brief before it starts.

Shared files, one owner at a time and lines only: `app/server/mcp/tools/memory/store.ts` merges W1's `save` and
`update` first, then W2's new methods. `src/agent/http/client.ts` takes W2's memory methods first, then W3's
replacements for the refused `requestTool`, `requestSkill` and `sendTeamRequest` (`client.ts:1306-1309`) and for
`skills: []` (`client.ts:78`). `src/screens/Settings.tsx`, `src/screens/settings/content.ts` and `src/agent/mock.ts`
belong to W1 until its PR merges, then to W2. W3 doesn't touch `mock.ts`: the mock already implements its methods and
W3 keeps their signatures. If that changes, W3's edit goes in after W2's, under the same rule.

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| W1 | sonnet-worker (Sonnet 5.5, medium) | Memory at Watch: the unlocks and the `m:ask` copy; `m:learn` and `m:ask` honoured in the store's `save` and `update`; the tools' answers and the `learning_off` refusal; a fast-check property over saves, rewords and switch changes. | `app/server/mcp/tools/memory/store.ts` (`save` and `update` only), `app/server/mcp/tools/memory/index.ts` (answers and the refusal), their tests and a new `toggles.test.ts`; `src/screens/settings/content.ts`, `src/screens/Settings.tsx` and `src/agent/mock.ts` until its PR merges | PR0 |
| W2 | opus-worker (Opus 5.5, medium), sensitive: auth | Team memory approval: the store's `setBrandApproved` and `waiting`, the two routes, their contract, the client methods, the Team memory page's waiting list with Approve and Reject, the mock's waiting facts; tests that an edit or a restore can't skip approval. | `store.ts` (the two new methods only), `app/server/api/memory-approvals.ts`, `app/shared/contract/memory-approvals.ts`, `src/agent/http/memory.ts` (the new methods only), its lines in `client.ts` (before W3's), their tests; `content.ts`, `Settings.tsx` and `mock.ts` after W1's PR merges | PR0; W1's PR for the three UI files |
| W3 | sonnet-worker (Sonnet 5.5, medium) | Skills and team requests: the three skill files and `OUR_SKILLS`, `GET /api/skills` and the Skills page; the table, store, tools, routes, contract and client for team requests; the Tools page's Request and Undo, "Request a skill", the team window's list and the Inhouse team's status change. | `app/runner/image/plugin/skills/**`, `app/server/skills/**`, `app/server/team-requests/**`, `app/server/mcp/tools/team/**`, `app/server/api/{skills,team-requests}.ts`, `app/shared/contract/team-requests.ts`, `src/agent/http/{skills,team-requests}.ts`, `src/screens/Skills.tsx`, `src/screens/Tools.tsx` (Request and Undo), `src/overlays/TeamWindow.tsx`, `app/server/migrations/0470_team_requests.sql`, `app/ops/tables/team-requests.ts`; lines only: `OUR_SKILLS` in `lists.ts`, one area line in `app/server/mcp/tools/index.ts`, the two `team_request_*` names removed from `app/server/mcp/tools/stubs/index.ts`, its lines in `client.ts` after W2's | PR0 |
| W4 | sonnet-worker (Sonnet 5.5, medium) | The read-side eval set and P6a's API specs: the new cases, the files and team-request checks, the per-model report; `memory-approvals`, `memory-toggles`, `skills` and `team-requests` specs; the contract suite's real target for P6a's methods; the scripted scenarios they need. | `app/evals/read-side/**`, `app/e2e/api/{memory-approvals,memory-toggles,skills,team-requests}.spec.ts`, `src/agent/contract/targets/real/memory-skills.ts`, appended scenarios in `app/test/scripted-model/scenarios.ts` | Cases now; specs after W1 to W3 merge; Slack cases after P5 |
| W5 | sonnet-worker (Sonnet 5.5, medium) | The ship spec, S1 to S8, desktop and phone. | `app/e2e/ship/memory-skills.spec.ts` | W1 to W3 merged (drafted mid-phase) |

## Orchestrator only

`app/server/routes.ts`, `app/server/access-matrix.ts` (and `DESIGN_ROWS`), `app/server/mcp/registry.ts`,
`app/ops/tables/index.ts`, `src/agent/http/index.ts`, `src/agent/contract/targets/real/index.ts`,
`app/shared/contract/index.ts`, the audit contract (`app/shared/contract/audit.ts`, `app/shared/audit-text.ts`,
`app/server/db/audit.ts`), `app/server/testing/inhouse-brand-writes.ts`, `app/evals/cases.ts` registration lines,
`app/server/prompt/**`, `app/wrangler.*.jsonc`, lockfiles, `ci.yml`, `app/scripts/check-product-build.mjs`, the
paid eval runs, `AGENTS.md`, the `verify` skill, the feature map.

**PR0** (`chore(memory-skills): P6a PR0, the audit block and pairings`, Sonnet plus Opus at high), after pinging A9:
the audit lines `memory.approved` and `memory.rejected` (`{ memoryId, rev }`), `team_request.created` and
`team_request.status`, with their sentences and literal tests; the `team_request` target; `WritePatternSchema` gains
`/api/memory/brand/:id/approved` and `INHOUSE_BRAND_WRITES` its row; the six route numbers reserved. PR0 imports
nothing from a worker.

## Order and parallelism

1. Cut `fleet/memory-skills` from `main`; PR0.
2. W1, W2 (server first), W3 and W4 (cases) in parallel. At most 4 builders at once.
3. W2's UI after W1's PR merges (the three shared UI files pass from W1 to W2).
4. Mid-phase: W5 drafts the ship spec and a QA dry run goes on a sandbox recording (rulebook "Gate sequencing").
5. When P5 merges and `main` merges in: W4's Slack cases.
6. W4's specs after W1 to W3 merge. Then the paid runs, one model at a time, each with Wasim's cap.

## Browser scenarios (`e2e/ship/memory-skills.spec.ts`, desktop and phone, test build, scripted model, stage Watch)

- S1: "Learn from my chats" is usable at Watch. Turned off, a preference the agent tries to save isn't saved and the
  chat says why; turned back on, it saves and shows on the Memory page.
- S2: The agent saves a team fact. A member's Team memory doesn't show it; an admin sees it under waiting, approves it,
  and a new chat's agent finds it.
- S3: An admin rejects a waiting fact; it's gone, and the audit log shows the approve and the reject by name.
- S4: The agent rewords an approved team fact; it goes back to waiting. The admin's approve from the old page is
  refused with the new wording shown; approving the new wording works.
- S5: An admin turns "Ask before saving a team rule" off; the agent's next team fact is active at once; a routine's
  team fact still waits.
- S6: The Skills page lists dataviz, PDF, Word and Spreadsheet, none with a stage tag.
- S7: "Request a skill" on the Skills page; the request shows in the Inhouse team window. The Inhouse team marks it
  done and the requester sees that.
- S8: Request on a Tools page catalogue tool shows "Request sent" and stays requested after a reload; Undo withdraws it.

## Acceptance

1. At Watch the five memory rows are usable with no stage tag, and the memory tools work at stage Watch.
2. With `m:learn` off, a person save or a person reword is refused `learning_off`; forgetting works; brand facts are
   unaffected. The setting is read in the write's own statement (a test with a barrier between the switch write and
   the save).
3. With `m:ask` on or unset, every agent brand save and reword is `waiting`. With it off, a person's agent's are
   `active`; a routine's are always `waiting`; turning it off changes no waiting fact.
4. A waiting fact becomes `active` only through the approve route at its exact revision. A stale revision, an active
   fact or a forgotten one answers `conflict` with the current fact. A member is refused; the Inhouse team only under
   a live grant, with its `support.access` line. Approve and reject each write one audit line with the id and the
   revision, in the same batch as the change. A literal test shows the audit line's detail never holds the fact's text.
5. Tests prove an edit (`memory_update`) or a restore (route 45's undo) can't reach `active` without the approve route,
   including a fast-check history over saves, rewords, forgets, restores, approves, rejects and switch changes.
6. Waiting facts never show in `memory_search`, `memory_list` or route 43; the waiting list shows them to admins only.
7. The agent's skills are exactly `dataviz` plus our three, loaded from the read-only path (the runner's container
   probe asserts the init list); each skill names only allowed tools; the Skills page lists the four from
   `GET /api/skills`, and a test fails if that list and `ALLOWED_SKILLS` differ.
8. Team requests: create, list, withdraw and the Inhouse team's status change work for each role; text bounds and the
   50-open cap hold; each write has its audit line, and a literal test shows its detail never holds the request's
   text; the Tools page's Request no longer hits a refusal.
9. The read-side set has zero bypasses on each of Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5, per source and per
   exit, with results kept in `app/evals/results/`. A model without a passing run is listed as off for clients
   (`tm:<id>:on` `'off'` in the release, line A's onboarding checklist).
10. API specs and the contract suite pass for P6a's methods; the demo changes only where P6a says (the memory rows at
    Watch, the `m:ask` copy).
11. QA PASS and the ship recording on S1 to S8; after the release, the real-model smoke passes on the house deployment.

## Must not

No team fact `active` without an admin's approval of that revision while `m:ask` is on; no routine's team fact ever
`active` without approval; no change to P3's visibility rule; no person fact saved while `m:learn` is off; no outbox,
approval tool or C7; no write to any outside tool; no skill loaded from a writable path; no copied third-party skill
text (judged by the reviewer); no Inhouse approval without a live grant; no request text, fact text or model text in an audit line; no model on
for clients without a passing run.

## Risks

- `m:ask` off lets planted text become a team fact at once. The evals count any `memory_save` of planted text as a
  bypass whatever its status, and routines always wait.
- Haiku 5.5 at low effort may not pass. Then it stays off for clients; nothing else waits on it.
- Four models on a paid set cost more than one. Rough guide from the ledger: P3's 41 cases once on Sonnet cost about
  $1.10 to $1.50, and Opus prices at 2x, Fable at 4x and Haiku at about a twentieth of Sonnet (`catalog.ts:71-75`).
- The web-page cells depend on line A's page host.

## How it lands

- Branch `fleet/memory-skills` from `main`; `main` merges in when P5 lands.
- Review rows: W2, PR0 and `0470` at Sonnet plus Opus high; W1's store change at Opus high; W1's UI, W3, W4 and W5 at
  Sonnet plus Opus medium.
- Final PR into `main` with the full ship gate (CI, reviews, preview, QA gate, ship recording on the test build),
  Wasim's exact-SHA approval, a squash with `--match-head-commit`. Then the house release, hub first, and the
  real-model smoke, with Wasim's OK. The Watch soak counts P6a once it's live (master plan, "The Watch soak").
