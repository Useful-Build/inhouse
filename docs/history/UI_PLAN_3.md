# UI plan 3: settings, team window, review panel, Activity, Routines and Skills

> History. This tracker is finished and kept as written. Paths in it are relative to `app/`. Wasim settled D2 to D5 on
> 2026-11-23: see standing decisions 6 to 8 in `docs/plans/2026-11-22-master-plan.md` (D2 dropped, D3 and D5 in P6a,
> D4 a PR into `main`).

Tracks the interface round Wasim asked for on 2026-11-23. Paths are relative to `app/`. Update this file in every PR of the plan: tick what landed, add the PR link, note anything moved or dropped and why.

**Status: every surface locked and built on `feat/ui-round-3`, one PR.** Wasim approved the round (2026-11-23); the mockups live on the design canvas ("Inhouse UI round 3", his private artifact). The canvas was the visual source; where this file and a mockup disagree on data, this file wins. D2 to D5 below stay open: they're backend decisions, and the product build hides what waits on them.

| Surface | Mockup | Built |
|---|---|---|
| Settings menu | **Locked** (round 1) | Yes: five sections, the lock and its tooltip |
| Team window | **Locked** (round 1) | Yes: New request and Your requests tabs, Open and Closed, Withdraw (demo only until a withdraw route lands) |
| Routine panel | **Locked** (round 1) | Yes: schedule sentence with the On switch, Run now, Edit in a chat, Delete in its "···" menu |
| Review window | **Locked** (round 4, then the two-button footer) | Yes: wide, short, centered beside the sidebar, the main action and More |
| Approvals page | **Kept** (Wasim: "don't change the approval cards") | Only the "···" became a More button, with Don't send first in it |
| Activity | **Locked** (round 3, then "like All chats") | Yes: All chats rows, tabs, search, the side sheet |
| Skill page | **Locked** (round 3) | Yes: `#/skills/<slug>`, the 9 full sample bodies |
| Sidebar | **Decided** (D6) | Yes: Library in the first group, the collapse button in the bottom row |
| Today cards, account menu, page widths, copy | Decided in chat (below) | Yes |

**The agent's mark:** the Inhouse mark (`InhouseMark`) signs the agent's work wherever a mark is needed ("Your Inhouse agent suggests"). The three-dot `AgentMark` is used only while a chat answer is loading.

**Audience rule (Wasim, 2026-11-23, now in `DESIGN.md` and master plan decision 5):** members and admins are non-technical to semi-technical. Show outcomes in plain words; hide mechanics.

**The rule for every surface:** the layout renders what the backend sends, never hard-coded copy. Each element below is tagged with where its data comes from:

- **[Live]** produced by the server on `main` today.
- **[Branch]** built on an unmerged `fleet/*` branch (lands with that milestone).
- **[Planned P6b / P7 / P8]** in the master plan (`docs/plans/2026-11-22-master-plan.md`), Part 2 unless noted.
- **[Mock]** only in `src/agent/sample-data/` today, with no backend and no plan. The design keeps a slot for it only if it's hidden cleanly when absent.
- **[New]** a small backend addition this plan proposes (needs Wasim's OK before it's built).

## The list

| # | Surface | Ask | Recommendation |
|---|---|---|---|
| 1 | Settings menu | Proper sections, search on top, like the reference | Five named sections, search kept on top, the menu built from data (`menuFor()`), not a fixed constant |
| 2 | Team window ("Your Inhouse team") | More premium layout; open requests wired to the backend | Wider window: request form first with kind tiles, requests list with Open and Closed tabs, real statuses only |
| 3 | Review panel (Today and Approvals) | Better layout, less crowded, premium | Round 2: one centered "brief" window that reads like a memo: headline, figure row, the agent's fix as a real letter, footnoted sources, a decision bar; "1 of 4" queue stepping |
| 4 | Activity | A more premium layout if there's a better one | Day groups with filter tabs, each run grouped with what it did, a cleaner expanded row |
| 5 | Routines | Drawer is fine, improve if possible | Keep the side panel; lead with a plain schedule sentence, an On switch instead of a Pause button, run history with outcome per run |
| 6 | Skills | Not a drawer: a big scrollable window or page, SKILL.md rendered | A full skill page (`/skills/<name>`): header, try-it composer, the rendered skill body, a side rail of facts |
| 7 | Skills sample data | The 9 skills are one-liners | Write a full, believable body for each of the 9 sample skills (When to use, Inputs, Steps, Safety, Output) |

## 1. Settings menu

**Today:** one fixed constant `MENU` in `src/screens/settings/menu.ts` with two groups. Members see every page; gating is per row through `allowance()`. Search already matches pages and row keywords.

**Sections (14 pages once P5 lands):**

| Section | Pages |
|---|---|
| You | General, Notifications, Memory |
| Agent | Inhouse agent, Models, Team memory |
| Approvals and limits | Who approves what, Run limits, Spending cap |
| Team | Members, Slack notices (only when Slack is connected, [Branch] P5) |
| Workspace | Stage and plan, Data and access, Audit log |

- The section header carries no "admins" text. For someone without `editBrandSettings`, a team section shows a small lock icon with the tooltip "Admins change these" (data: `me().can` [Live]).
- `MENU` becomes `SECTIONS` with stable ids; `menuFor(ctx)` filters pages (Slack) [Branch]. The command palette and search take the same list.
- Search stays on top. A search with no match shows "No settings match" and a clear button.
- **The settings menu sits next to the app's main sidebar**, as it does today. Settings never becomes a full page that hides the main sidebar.
- **Icons must read as high quality**: every menu icon renders through `<Icon>` at the same optical size and weight as the text beside it (Material Symbols Rounded, `opsz` 20). Check each one in light and dark at 1x and 2x before merge, and replace any that look thin, blurry or off-family (memory, models, spending cap, audit log are the first to check).
- Phone: the menu is the first screen, each section a group of rows, like today.

## 2. Team window

**Backend [Branch] P6a #344:** `team_requests` with `kind` (tool, job, change, bug, feedback), `subject` (64), `text` (1000), `requestedBy`, `mine`, `status` (open, done, declined, withdrawn), `at`, `updatedAt`. Routes: list (with `status=`), create, withdraw (asker only), done or declined (Inhouse team only, no UI yet). **On `main` it's mock data**; "Live by Fri, Nov 20" and "Call on Thu, Nov 19" exist only in sample data.

**Design:**
- `md` window widened to `lg`-narrow (720px), header: Inhouse mark, "Your Inhouse team", one line on what they do.
- "New request" first (it's why people open it): five kind tiles (icon, label), a short title field (`subject`), the details field (`text`, counter at 900+), Send.
- "Requests" below with tabs Open and Closed (the API already filters by status; the client reads only open today). Each row: kind icon, subject, "Asked by Priya, Nov 9", status chip. Open rows the person asked show Withdraw in the row menu. A row opens to show its full text.
- Status chips map only real statuses: open = "With the team", done = "Done", declined = "Declined", withdrawn = "Withdrawn".
- The promise "They reply within one working day" stays demo-only (the product drops it today).

**Not in any plan (needs a decision, see D2):** dated statuses ("Live by", "Call on"), an Inhouse team note on a status change, replies, attachments, an assignee name.

## 3. Review panel

**Backend reality on `main`:** only Watch exists. The morning check produces `title`, `area`, `sev`, `cost` and `costNote`, `sources` (logo always Shopify), `found` rows as label and value pairs, `next` (suggested next step) and `trace` (the run id, not shown yet). **Everything from the stepper down (facts, draft, memory line, approver, approved and handled states) is [Mock]**; drafts, approvals, the 10 s send hold and the approver rules are **[Planned P6b]**, handled jobs with Undo **[Planned P7]**.

**As built:** see "Decisions taken while building": the footer is the main action and More, the approver note sits under the draft.

Rounds 1 (side panel, split view) and 2 (a 760px memo window) were rejected as too big and too detailed for this audience. Round 3 (shaped with a Gemini 4 Neon consult) was a 580px window; Wasim asked for the card shape instead. **Round 4: a centered 960px window, wide and short like the Approvals cards**, the same from Today and Approvals. Two columns: on the left the top line, title, brief and the collapsed "Checked ..." line (at Watch also the found rows); on the right the draft on one white sheet (at Watch, the suggestion signed with the Inhouse mark). The footer spans both: the outcome button and More. The parts below stay as listed.
1. **Top line:** "Urgent" in red text (only when urgent) and the area; "1 of 5" with up and down; Close.
2. **Title** (22px) and a **two-sentence brief** in plain words: what's at risk and what the agent drafted (`cost`, `costNote`, the draft's title).
3. **The draft on one white sheet:** an email (recipients, subject, body, Edit) or an order (supplier, items, total, Edit). At Watch: a tinted "Your Inhouse agent suggests" block with `next`.
4. **One collapsed line**, "Checked Shopify and ShipBob at 6:05 AM", that opens the found rows and sources.
5. **Footer:** a primary button that names the outcome ("Approve and email 5 customers", "Approve and send the $9,600 order") and More. At Watch: Ask Inhouse and More.
- **After Approve** the window moves straight to the next draft; the existing toast holds the 10-second Undo.
- **Never shown:** number tiles, footnotes, steppers, the memory line, keyboard badges, step timings, costs.

**Approvals page:** unchanged. The cards stay as they are in the app today; Review draft opens the review window.

**Fixes needed whatever the layout:** `found` rows render as label and value pairs, not one run-on sentence; show `since` (dropped by `toProblem` today) as "Since Tue"; the panel must not show an empty draft if a real deployment is set to Act before P6b.

## 4. Activity

**Backend:** `GET /api/activity` [Live] with server templates (routine runs, morning check, changes, set aside, Library). Approved, waiting and handled rows are built in the client from mock state. TraceWindow's real steps are root, tool, model, approval and fail.

Rounds 1 and 2 were rejected (inline grey boxes; then a split view with step timings and costs). **Round 3:** one 760px column beside the main sidebar. Header: title, All / Needs you / Changes, a search button. Each day is one card of flat 56px rows: time, a quiet icon, one plain sentence, and who on the right (You, Priya, Agent) or "Needs you" in amber. No nesting. A click opens a 440px side sheet: status and time, the title, one paragraph joining `why`, `result` and `by`, the one action (Review the draft, or Undo), and a collapsed "How your agent worked it out" with plain step sentences from the trace. No timings, costs or the word "trace".

## 5. Routines

**Backend [Live]:** routines API (routes 52 to 56), Run now, Pause (toggle), Delete with Undo, `canManage`. No per-routine run history API (matched by name from Activity), `what` cut at 200 characters.

**Design:** keep the side panel. Header: name and one-line `what`. A schedule sentence ("Every weekday at 6:00 AM. Next Tue, Nov 17.") with an On switch (the `r:<id>` toggle) replacing the Pause button. Actions: Run now (primary), Edit in a chat, and Delete in a menu. "How it works" as one line under the schedule. Last runs: time, outcome sentence, Steps.

**[New] small additions (optional, D4):** `GET /api/routines/:id/runs` from the run slots table (state, outcome, run id), and the full instruction on the detail read.

## 6. Skills page

**Backend:** `SkillDef` is `n`, `d`, `icon`, `need`, `by`, `used`, `mine?`. [Branch] P6a serves 4 skills (dataviz, pdf, word, spreadsheet) with no body; their SKILL.md files live in the runner image. No per-brand switch is planned (every skill is always on); custom skills arrive as `job` team requests.

**Design (round 2):** a page at `/skills/<name>`, back to Skills.
- Header: icon tile, name, stage tag, one-line description, and who made and last changed it. Actions: "Edit in a chat" (D5), "Try in a chat" (primary) and a More menu. No "Request a change".
- A try-it strip: a composer prefilled with the skill chip and an example ask.
- Body (round 3): clean text only, like the OpenBot reference. A quiet "Instructions" label, then one card with the SKILL.md rendered by `Markdown` (frontmatter stripped): section headings, bullet and numbered lists, short bold lead-ins. No icons, no logos, no file bar. Written in plain words for non-technical readers.
- Side rail: facts (Works from, Made by, Who can change it, Used), Tools it reads, Used by, Versions with "Restore the Inhouse version" (D5).

**Who can create and change skills (checked 2026-11-23):** today nobody can. P6a ships every skill in the runner image, always on, and lists "per-brand skill switches; skills a brand writes" as out of scope; no later phase adds them. The only path is "Request a skill", which files a team request. Wasim wants teams to create, improve and edit skills themselves (in a chat), so this is **D5**, a new backend item, modelled on routines (`routine_update`): an agent tool saves a brand version of a skill (body and a one-line change note), admins' edits apply at once, members' edits wait for an admin (like team memory's "Waiting for your OK"), the Inhouse version stays restorable, and the runner loads the brand's versions at session start under the same guards.

**[New] (D3):** add optional `body`, `tools`, `updatedAt` to `SkillDef`; copy the runner's SKILL.md files into the Worker bundle at build and serve the body on `GET /api/skills/:name`. Without it the product page shows the header and rail only. `dataviz` ships with Claude Code, so its body can't be copied; it gets our own short summary.

## 7. Skills sample data

Rewrite `sample-data/skills.json` so each of the 9 skills has a full body: When to use (3 to 4 points), Inputs, Steps (4 to 7), Safety rules, What you get. All invented, Northline brand.

## Decisions for Wasim

- **D1 Review panel (decided):** one wide, short window centered beside the sidebar, the same from Today and Approvals, with two buttons (see below).
- **D6 Sidebar (decided by Wasim, 2026-11-23):** Library moves up into the first group (Today, Approvals, Activity, Library). Skills, Tools and Routines keep their names ("Skills" is the standard word for agents). Keep the current roomy row spacing. Activity stays top-level. Not decided: a visible "Your Inhouse team" row above the account row (Gemini and Fable both suggested it). Not built.
- **Windows sit beside the sidebar (Wasim, 2026-11-23):** on desktop every centered window (the review window, the team window and the rest) centers in the area right of the sidebar and never covers it.
- **Activity looks like All chats (Wasim, 2026-11-23):** the same clean list rows as the All chats page: one icon for every row, the sentence, the time on the right. No per-kind colored icons or status words in the row.
- **D2 Team requests:** add an optional `eta` date and a `note` from the Inhouse team to route 82 (and a small ops UI to set them), or show only Open, Done, Declined and Withdrawn.
- **D3 Skill bodies on the product:** add the `body` read ([New]) or keep the product page to header and rail.
- **D4 Routine run history API:** add it ([New]) or keep matching Activity by name.
- **D5 Teams create and edit skills:** add brand skill versions (create, edit in a chat, members' edits wait for an admin, restore the Inhouse version) as a new backend item, and decide where it lands: Part 1 next to P6a, or Part 2 at the first client. Until it's built, the page hides Edit in a chat and Versions.

## Decisions taken while building (Wasim, 2026-11-23)

- **Two buttons in the review window:** the main action (the outcome with its amount, or Ask Inhouse at Watch) and a More button with a chevron. More holds Don't send first (with a divider under it), then Ask <approver>, Ask Inhouse (outside Watch), Snooze until tomorrow and Not a problem. No separate Don't send button, no "···".
- **Don't send lives in More** on the review window and on the Approvals cards (first item). The Approvals card's "···" is the same outlined More button.
- **The approver note** ("Leo usually approves orders over $5,000") sits under the draft as a quiet note with a person icon, never in the footer. Asking them is in More.
- **Ask Inhouse** names asking the agent everywhere: the card menu, the review window's Watch button and its More item, the composer's label ("Ask Inhouse", "Message Inhouse").
- **Windows sit beside the sidebar:** on desktop every centered window centers in the room right of the sidebar and caps its width there (`--app-side-offset`, from `data-side` on `<html>`).
- **Page widths:** list pages share one 1040px content edge (was 900px); a skill's page is 1160px with a 264px rail; side padding is 16 to 32px.
- **The sidebar button** moved out of the top bar into the sidebar's bottom row, beside the account row (on the rail, above the avatar).
- **Quieter Today cards:** a card's "···" is a ghost button, with no fill until hover.
- **Account menu:** the role is a badge beside the name, the email on its own line.
- **Copy:**

| Where | Was | Now |
|---|---|---|
| Card menu, review window | Ask about this | Ask Inhouse |
| Today greeting | Good morning (always) | Good morning, Good afternoon or Good evening by the app's clock (Welcome on day one) |
| Today, Run strip | N handled before you woke up | N handled today |
| Today, nothing waiting | Nothing needs you today. / Nothing is waiting on you. | You're all caught up. |
| Today, Act headline | N things need you. A fix is drafted for each. | N things need you. Drafts are ready. (1 thing needs you. A draft is ready.) |
| Today, First day | Your Inhouse agent is being set up. | We're setting up your Inhouse agent. |
| Today, Loading | Your Inhouse agent is reading your tools. | Your Inhouse agent is checking your tools. |
| Composer | Message your Inhouse agent / Ask your Inhouse agent | Message Inhouse / Ask Inhouse |
| New chat | What do you want to know? / Your Inhouse agent reads {tools}. | What should we look into? / Connected to {tools}. |
| Settings menu | Your settings / Team settings · admins | You, Agent, Approvals and limits, Team, Workspace (a lock with "Admins change these" for members) |
| Team window, sent (product) | Request sent. Your Inhouse team replies within one working day. | Request sent to your Inhouse team. (the promise stays demo-only) |

## PRs

The round landed as one PR from `feat/ui-round-3` (its six parts were built on `ui3/*` branches and merged into it).

| Part | Scope | Status |
|---|---|---|
| 1 | Settings sections and data-driven menu | Built on `feat/ui-round-3` |
| 2 | Team window | Built on `feat/ui-round-3` |
| 3 | Review window (Today and Approvals) | Built on `feat/ui-round-3` |
| 4 | Activity | Built on `feat/ui-round-3` |
| 5 | Routines panel | Built on `feat/ui-round-3` |
| 6 | Skill page and the 9 skill bodies | Built on `feat/ui-round-3` |
| 7 | Sidebar, page widths, account badge, copy pass | Built on `feat/ui-round-3` |

Every part: tokens only, `src/ui` parts, both themes, 390px and 1440px, `npm run lint`, `npm run typecheck`, unit, a11y and visual suites, a screenshot check in the running app, an E2E scenario, and the matching `FEATURE_MAP.md` lines.
