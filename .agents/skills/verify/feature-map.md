Status: approved by Wasim, 2026-11-19 (revised map, PR #20).

# Inhouse feature map

Format and workflow: global `verification` skill, `references/feature-map.md`. Each entry has a `Covered:` line naming its spec files, or `gap`. Seed every path with `?demo` at Stage Act and Scenario Normal unless it says otherwise (see [SKILL.md](SKILL.md)). Gaps are listed first.

## Gaps

No entry is `Covered: gap`. Not checked by any spec, or only in part:

- Motion: `e2e/motion.spec.ts` is manual only (`MOTION=1`, the `motion` workflow), never in CI's normal run.
- Ship specs: `e2e/ship/agent-seam.spec.ts`, `e2e/ship/example.spec.ts`, `e2e/ship/setup-gaps.spec.ts`, `e2e/ship/hardening.spec.ts` and `e2e/ship/backend-core.spec.ts` (projects `ship-desktop` and `ship-phone`) are manual only, run by `ship.yml` against a PR's preview (`backend-core.spec.ts`: on the test build, `build=test`), never in CI's normal run.
- Trace window: Replay is only clicked, never asserted; the replay speed, Pause replay, Restart, Stop and show everything, Replay result and a step's details are opened by no spec.
- Settings > General: Language and Text size are opened and closed by `menus.spec.ts`, but no spec picks one and checks it saves.
- Icons: the fallback glyph for a name outside the manifest is drawn by `src/ui/index.tsx` but no spec checks it; a name
  missing from the font fails lint (`scripts/check-icons.mjs`), not a spec.
- Export everything is a stub, and so is Sign out in the demo: specs check they say so and change nothing. In the product Sign out goes to Access's logout; `e2e/real/sign-out.spec.ts` checks the account menu goes to that path on the test build (no Access there); the real Access logout is checked on the candidate deploy (pending).
- The WebSocket under the enforced CSP is P3's: P2 has no WebSocket route, so `connect-src 'self'` is checked for fetch only (`e2e/real/csp-download-photo.spec.ts` covers the audit CSV download and a member photo).
- A failed or never-run chat turn's words after a reload (its stored end row, P3) and a trace's "up to" cost while a model call is open are proven only by unit tests (`server/do/brand-agent/projection.test.ts`, `src/screens/chat/history.test.ts`, `src/lib/trace-cost.test.ts`): the test build has no container and no way to force a placement failure or hold a call open without new test code in the deployable bundle.
- "A failed audit write leaves no change" (Acceptance 6) is proven only by the server unit tests on the vitest workerd (compat 2026-11-11), not on the test build's: forcing an audit write to fail there needs test code in the deployable bundle.

## Today

Today: needs-you cards
  Path:     Today
  Selector: article cards, button "Review"
  Expected: only the title, the composer and the Needs you cards show, at every stage; no card cuts text
  Covered:  e2e/dots-and-today.spec.ts, e2e/today-approvals.spec.ts

Today: snooze and dismiss
  Path:     Today -> card "···" menu -> Snooze or Dismiss
  Selector: card menu items, Approvals badge
  Expected: the card leaves Today and Approvals, the badge agrees, a reload keeps it, Reset demo clears it
  Covered:  e2e/page-actions.spec.ts

Today: open a card
  Path:     Today -> click the card
  Selector: one real button per card, the "···" menu is separate
  Expected: the problem panel opens; the menu doesn't open it
  Covered:  e2e/today-approvals.spec.ts

Today: sort at Run
  Path:     Today at Run -> Biggest amount first
  Selector: sort control
  Expected: handled cards stay after the cards that need you
  Covered:  e2e/cross-screen.spec.ts

Today: composer logo row
  Path:     Today -> composer
  Selector: tool logos, "+N" chip
  Expected: 3 logos, a +N chip for the rest, and the count is real
  Covered:  e2e/dots-and-today.spec.ts

## Approvals

Approvals: approve, edit, Undo
  Path:     Today -> Review -> Approve and send (or Edit first)
  Selector: panel button "Approve and send to Kestrel", toast "Undo"
  Expected: "goes out in 10 seconds" toast; Undo inside the hold cancels the send; a reload during the hold still sends it; Reset demo during the hold sends nothing
  Covered:  e2e/app.spec.ts, e2e/state.spec.ts, e2e/page-actions.spec.ts

Approvals: a draft with no text
  Path:     Approvals -> Edit on a draft with no text
  Selector: note field in the panel
  Expected: the panel opens on a note field and the note survives approve and Undo
  Covered:  e2e/today-approvals.spec.ts

Approvals: approve all low-risk
  Path:     Approvals -> Approve all low-risk
  Selector: button "Approve all low-risk", toast "Undo"
  Expected: three drafts approved, one Undo takes all three back
  Covered:  e2e/today-approvals.spec.ts, e2e/toasts.spec.ts

Approvals: Don't send and sort
  Path:     Approvals -> Don't send, sort control
  Selector: card menu, sort
  Expected: card leaves with an Undo; sort reorders; counts leave set-aside problems out
  Covered:  e2e/page-actions.spec.ts

Approvals: loading and first day
  Path:     Approvals at Loading and First day
  Selector: status text
  Expected: loading status, no sort, no approve-all, no cut text
  Covered:  e2e/today-approvals.spec.ts

Toasts
  Path:     approve twice, delete two routines, hover, F6
  Selector: `[data-toast]`, role "status"
  Expected: two approvals share one toast with one Undo; at most four toasts; a held approval is never pushed out; hover pauses the countdown; focus moves to the next toast then the page
  Covered:  e2e/toasts.spec.ts

## Chats and conversation

Chat: ask a question
  Path:     Today or a chat -> composer -> Send
  Selector: composer field, Send, Stop
  Expected: the stuck-orders question gives the same table and a 6-step, 9.4 s trace; Stop ends the run and says nothing was changed; Send is off while the field is empty
  Covered:  e2e/app.spec.ts, e2e/composer.spec.ts

Chat: composer files
  Path:     composer -> paste or drop files
  Selector: file chips
  Expected: chips appear; a file over the limit says why and isn't added; each chat keeps its own draft and files
  Covered:  e2e/composer.spec.ts

Chat: Google Drive and Slack stubs
  Path:     composer -> Attach -> From Google Drive; answer -> More -> Send to Slack
  Selector: menuitem "From Google Drive", menuitem "Send to Slack", toast
  Expected: each says "<What> isn't connected in this demo." and changes nothing; the approver's "Ask Leo" button says the same (`sample-data.spec.ts`)
  Covered:  e2e/not-connected-stubs.spec.ts

Chat: Dictate
  Path:     composer -> Dictate
  Selector: button "Dictate", toast
  Expected: for now it says "Dictation isn't connected in this demo." and leaves the field alone. Dictation stays a feature: a model gets connected later, and this check changes when it lands
  Covered:  e2e/not-connected-stubs.spec.ts

Chat: answer actions
  Path:     answer -> hover or Tab into the row -> Reply, Copy, Regenerate, thumbs, More; More -> Send to #channel, Report a wrong answer, Delete
  Selector: answer row buttons, `[data-answer-actions]`, menu "Message actions"
  Expected: at rest every answer (the newest too) shows only its steps line; hover or keyboard focus shows the actions and an open More menu keeps them; the menu has exactly Send to #channel (when a channel is connected), Report a wrong answer and Delete; the phone row is Copy, steps and More; markdown renders, Jump to latest appears when scrolled up mid-stream, steps open the trace
  Covered:  e2e/conversation.spec.ts, e2e/conversation-polish.spec.ts, e2e/brand-data.spec.ts

Chat: queue and edit
  Path:     send two messages mid-answer, Edit a question
  Selector: queued message, "Editing" label, Retry
  Expected: queued messages wait and send in order, Stop pauses the queue, Escape in an edit restores the draft
  Covered:  e2e/conversation-polish.spec.ts

Chat: runs in the background
  Path:     start an answer -> open another chat or the Library -> come back
  Selector: sidebar running dot
  Expected: the whole answer is there once; deleting a chat stops its run and Undo brings it back with a stopped note
  Covered:  e2e/run-lifecycle.spec.ts

Chat: See all and management
  Path:     sidebar -> See all (`#/chats/all`)
  Selector: search box, row menu, Select
  Expected: search filters by title; rename, pin, copy link, delete with Undo, bulk delete; a reload keeps it until Reset demo
  Covered:  e2e/chats-manage.spec.ts, e2e/sample-data.spec.ts

Chat: links
  Path:     `#/chats/<id>`, an unknown id or page
  Selector: URL
  Expected: Back and Forward move between chats; an unknown link lands where it would anyway and says so
  Covered:  e2e/cross-screen.spec.ts, e2e/mock-behaviour.spec.ts, e2e/state.spec.ts

Chat: mock answers
  Path:     ask a routine request or an off-script question
  Selector: routine row, suggestion chips
  Expected: a schedule and a time make one routine; an off-script question gets "can't answer from your tools yet" with chips
  Covered:  e2e/mock-behaviour.spec.ts

## Library

Library: browse and filter
  Path:     Library (`#/library`)
  Selector: tabs, places panel, search, view switch
  Expected: tabs and places filter with matching counts; search has an empty state with Clear; masonry, grid and list show the same files
  Covered:  e2e/library.spec.ts, e2e/library-polish.spec.ts

Library: viewer
  Path:     Library -> open a file
  Selector: viewer window, link back to the source
  Expected: the viewer opens, its link goes to the chat, routine or approval, arrow keys step through files, Back closes it
  Covered:  e2e/library.spec.ts, e2e/library-polish.spec.ts, e2e/page-details.spec.ts

Library: select and delete
  Path:     Library -> Select -> Delete
  Selector: confirm dialog, toast "Undo"
  Expected: delete asks first, Undo restores, the delete survives a reload
  Covered:  e2e/library.spec.ts, e2e/cross-screen.spec.ts

## Routines, Activity, Tools, Skills, Usage

Routines: details and actions
  Path:     Routines -> a routine
  Selector: switch "<name> on or off", Pause, Run now, Delete, Last runs
  Expected: details show; Delete asks and Undo works; all of it survives a reload; at Watch a routine is locked and shows its stage; a Run now lands in Last runs with its result and survives a reload
  Covered:  e2e/page-details.spec.ts, e2e/pages-polish.spec.ts, e2e/pages-polish-phone.spec.ts

Activity: log
  Path:     Activity
  Selector: rows, times
  Expected: every time sits on one line; the Klaviyo line takes its date from the data
  Covered:  e2e/sample-data.spec.ts

Tools: list and pages
  Path:     Tools (`#/tools`) -> a tool
  Selector: search, Pause access, Reconnect, Request a tool
  Expected: pausing or disconnecting changes the count, the tool page (Read, Draft, Access) and the composer alike; Pause access has Undo and Resume brings it all back; Request a tool opens the team window
  Covered:  e2e/data-states.spec.ts, e2e/page-actions.spec.ts, e2e/pages-polish.spec.ts, e2e/pages-polish-phone.spec.ts

Tools: Slack channel
  Path:     Tools -> Slack
  Selector: Slack row
  Expected: its own page with channel details and no tool abilities; before Act it says "included from Act"; Back returns to Tools
  Covered:  e2e/slack-channel.spec.ts

Skills
  Path:     Skills -> a skill
  Selector: switch in details
  Expected: turn a skill off and back on; search filters the list
  Covered:  e2e/page-details.spec.ts, e2e/sample-data.spec.ts

Usage
  Path:     Usage
  Selector: month picker, daily bars
  Expected: totals agree in every breakdown; bars are one tab stop with arrow, Home and End; a cap below spend shows the capped state
  Covered:  e2e/app.spec.ts, e2e/page-actions.spec.ts, e2e/edge-cases.spec.ts

## Settings

Settings: dropdowns and fields
  Path:     Settings -> any page
  Selector: dropdown, text field, search
  Expected: a dropdown opens a real list, works by keyboard, Escape cancels; a pick survives a reload and Reset demo clears it; text fields save and show in the account menu
  Covered:  e2e/sample-data.spec.ts, e2e/menus.spec.ts

Settings: Models
  Path:     Settings -> Models
  Selector: effort picker, on switch
  Expected: Max, Smart (default), Fast, Instant; switching one off hides it; effort persists; one "How hard it thinks" caption sits over the pickers
  Covered:  e2e/models-and-scroll.spec.ts, e2e/pages-polish.spec.ts

Settings: Members and approvers
  Path:     Settings -> Members, Who approves what
  Selector: role control, Remove
  Expected: removing Admin asks first; a demoted approver stays on rules that name them with a tag; a wrong cap shows why and isn't saved
  Covered:  e2e/page-details.spec.ts, e2e/edge-cases.spec.ts, e2e/cross-screen.spec.ts

Settings: Stage and plan
  Path:     Settings -> Stage and plan
  Selector: rows "Current stage" and "Next stage", button "Book a check-in"
  Expected: the page names the stage and the next one at Watch, Act and Run; Book a check-in opens the team window on "Change something". The page keeps nothing
  Covered:  e2e/settings-team-pages.spec.ts, e2e/no-persona.spec.ts

Settings: Team memory
  Path:     Settings -> Team memory
  Selector: buttons "Forget", switch "Ask before saving a team rule", button "Teach in a chat"
  Expected: locked at Watch; Forget removes a line with an Undo toast and the Inhouse agent page's count follows; the switch turns off; both survive a reload and Reset demo clears them; Teach in a chat opens a new chat holding "Remember that "
  Covered:  e2e/settings-team-pages.spec.ts

Settings: Run limits
  Path:     Settings -> Run limits
  Selector: job switches, "Daily limit", "Largest restock", button "Pause Inhouse agent"
  Expected: switches and limits are locked until Run; each works, lists its options and survives a reload; Pause stops the agent (button, toast and top bar agree, Resume undoes it) and survives a reload; Reset demo clears all of it
  Covered:  e2e/settings-team-pages.spec.ts

Settings: Notifications
  Path:     Settings -> Notifications
  Selector: dropdowns "Approvals waiting" and "Send alerts to", switches "Slack" and "Weekly report"
  Expected: locked at Watch; each dropdown lists its choices and saves a pick, the switches turn off; a reload keeps all of it and Reset demo clears it; the dropdown works by keyboard; with no channel connected alerts default to Email and there is no channel switch; on a phone the controls stay
  Covered:  e2e/settings-your-pages.spec.ts, e2e/sample-data.spec.ts, e2e/brand-data.spec.ts, e2e/settings-pages-phone.spec.ts

Settings: Memory
  Path:     Settings -> Memory
  Selector: buttons "Forget", switch "Learn from my chats"
  Expected: locked at Watch; Forget removes a line with an Undo toast; the switch turns off; both survive a reload and Reset demo clears them; Team memory is not touched; Forget works on a phone
  Covered:  e2e/settings-your-pages.spec.ts, e2e/settings-pages-phone.spec.ts

Settings: Inhouse agent
  Path:     Settings -> Inhouse agent
  Selector: dropdown "Tone", text field "Signs emails as", buttons "Open memory" and "View skills"
  Expected: the tone and sign-off save, survive a reload and Reset demo clears them; Open memory opens Team memory, View skills opens Skills; the memory count follows Team memory; on a phone the values read as text and the buttons work
  Covered:  e2e/settings-agent-data.spec.ts, e2e/settings-team-pages.spec.ts, e2e/page-details.spec.ts, e2e/settings-pages-phone.spec.ts

Settings: Spending cap
  Path:     Settings -> Spending cap
  Selector: field "Monthly cap", dropdowns "Alert at" and "Show amounts in"
  Expected: a cap and alert level show on Usage; a wrong amount says why and isn't saved; a cap below spend shows the cap banner and the capped state; the currency pick saves; values survive a reload; on a phone it reads as text
  Covered:  e2e/cross-screen.spec.ts, e2e/edge-cases.spec.ts, e2e/data-states.spec.ts, e2e/page-details.spec.ts, e2e/sample-data.spec.ts, e2e/pages-polish-phone.spec.ts, e2e/phone.spec.ts

Settings: Data and access
  Path:     Settings -> Data and access
  Selector: dropdowns "Chats" and "Activity and steps", switches "Inhouse team access" and "Two-step sign-in", buttons "Export" and "Ask the team"
  Expected: retention picks and the switches save, survive a reload and Reset demo clears them; the audit log's retention is fixed; Export says it isn't connected and changes nothing; Ask the team opens the team window on "Change something" with the delete request written; on a phone it reads as text and Export still answers
  Covered:  e2e/settings-agent-data.spec.ts, e2e/settings-pages-phone.spec.ts, e2e/no-persona.spec.ts

Settings: Audit log
  Path:     Settings -> Audit log
  Selector: rows, button "Download CSV"
  Expected: the seeded rows show; pausing the agent adds a row at the top that survives a reload and Resume takes away; Download CSV saves the log with plain spaces in its times; First day and Loading show their own empty line
  Covered:  e2e/settings-agent-data.spec.ts, e2e/sample-data.spec.ts, e2e/pages-polish.spec.ts, e2e/settings-pages-phone.spec.ts

Settings: General
  Path:     Settings -> General
  Selector: text field "Name", dropdowns "Theme", "Language", "Text size" and "Time zone", photo upload
  Expected: the name saves, shows in the account menu and Reset demo clears it; a time zone pick saves, survives a reload and Reset demo clears it, on a phone too; Theme as in "Palette: theme switch" below; every dropdown opens a real list (Language and Text size partial, see Gaps); the photo as in "Settings: photos"
  Covered:  e2e/sample-data.spec.ts, e2e/cross-screen.spec.ts, e2e/phone.spec.ts, e2e/menus.spec.ts, e2e/photo.spec.ts

Settings: photos
  Path:     Settings -> General -> photo
  Selector: upload, Remove
  Expected: the photo shows in the sidebar, account menu, Members, Activity and Usage; bad files give an error toast; reset clears it
  Covered:  e2e/photo.spec.ts

## Shell and states

Product build: Not connected yet
  Path:     `npm run build:product`, any URL (`?demo` and `?demo=<anything>` included)
  Selector: heading "Not connected yet", the product project (`E2E_PRODUCT=1`)
  Expected: one "Not connected yet" screen in place of every page; no sample name, no demo switches or Reset demo, `?demo` ignored (the demo clock's absence is proved by `scripts/check-product-build.mjs`)
  Covered:  e2e/product/no-demo.spec.ts

Test build: the product Worker's API and app (P2)
  Path:     `npm run build:product-test`, then `/api/*` with no Access JWT, and `/` in a browser
  Selector: the `api` project (status and body), the `real-desktop` and `real-phone` projects (heading "Not connected yet")
  Expected: every `/api/*` path (an unknown one too) answers 401 `{"error":{"code":"unauthorized"}}` with the security headers and `no-store`; the app loads under the enforced CSP with no violation
  Covered:  e2e/api/skeleton.spec.ts, e2e/real/skeleton.spec.ts

Backend core: account menu, name and role (P2, test build)
  Path:     sign in as a seeded person -> sidebar -> account and settings
  Selector: menu "Account" (name, `<email> · <role>`), items Your settings, Team settings, Sign out
  Expected: the menu shows the signed-in person's own name, email and role (Admin, Member or Inhouse team); Sign out goes to Access's logout (not checked in e2e)
  Covered:  e2e/ship/backend-core.spec.ts (S1, S5, S7, S8)

Backend core: Members page, invite and remove (P2, test build)
  Path:     Settings -> Members
  Selector: button "Invite", dialog "Invite someone", "Remove <name>", tag "Invited"
  Expected: an invite shows the person with the Invited tag; their first sign-in binds it and lands as a Member with the invited name; a removed member's next request is refused; a Member sees no Invite or Remove (the audit log and its download are theirs by the access matrix); on a phone the page is read-only (Invite only)
  Covered:  e2e/ship/backend-core.spec.ts (S5, S8, S9), e2e/api/members.spec.ts

Backend core: Settings, typed and with conflicts (P2, test build)
  Path:     Settings -> General (Time zone), Spending cap
  Selector: dropdown "Time zone", field "Monthly cap", toast "Someone changed this"
  Expected: a setting saves on the Worker and survives a reload; two tabs on one setting: the second save is refused and shows what the setting is now; a Member sees team settings as text
  Covered:  e2e/ship/backend-core.spec.ts (S2, S5, S6), e2e/api/revisions-paging.spec.ts

Backend core: photo (P2, test build)
  Path:     Settings -> General -> Photo
  Selector: file input "Photo file", Remove, the avatar in the account menu
  Expected: a PNG, JPEG or WebP under the cap uploads to R2 and shows in the avatar after a reload; the Worker serves it with `nosniff`
  Covered:  e2e/ship/backend-core.spec.ts (S4), e2e/api/photo.spec.ts

Backend core: audit log and its CSV (P2, test build)
  Path:     Settings -> Audit log -> Download CSV
  Selector: rows (person, what, detail, time), button "Download CSV"
  Expected: a change shows as a line with the person's name and the time; the CSV has the header When, Who, What, Detail and the same lines; the download is offered to a Member too (matrix rows 19 and 20); nothing can edit or delete a line
  Covered:  e2e/ship/backend-core.spec.ts (S3, S5, S7), e2e/api/audit.spec.ts

Backend core: Who can get in, support grants (P2, test build)
  Path:     Settings -> Data and access -> Who can get in
  Selector: row "Inhouse team access", dropdown "Give access for", buttons "Grant" and "End now"
  Expected: an Admin gives the Inhouse team access for 1, 4, 24 or 72 hours; while it is live the Inhouse team reads the audit log; after End now the audit log is refused and baseline reads still load; the audit log keeps the grant, its use and its end; on a phone the row is read-only
  Covered:  e2e/ship/backend-core.spec.ts (S7), e2e/api/grants.spec.ts

Backend core: "You're not on this team" (P2, test build)
  Path:     sign in as someone who wasn't invited, or was removed -> any URL
  Selector: heading "You're not on this team", button "Sign out"
  Expected: one screen in place of every page, with a Sign out link to Access (not checked in e2e)
  Covered:  e2e/ship/backend-core.spec.ts (S9)

Test build and release smoke (P2)
  Path:     `npm run build:product-test` -> `wrangler dev`; `e2e/smoke/` against the test build (CI) or a release (`SMOKE_BASE_URL`)
  Selector: the `api`, `real-desktop`, `real-phone` and `smoke` projects; `ship.yml` with `build=test`
  Expected: the API specs, the CSP-guarded browser specs and the read-only smoke pass; the ship recording of S1 to S9 runs on the test build (S10, the demo, is `agent-seam.spec.ts` with `build=demo`) and never against a release
  Covered:  e2e/api/*.spec.ts, e2e/real/skeleton.spec.ts, e2e/smoke/product.spec.ts, e2e/ship/backend-core.spec.ts

Demo upgrade: a stored demo
  Path:     a browser holding the demo as the build before the agent seam saved it -> open Today
  Selector: sidebar chat, model button, chat composer, Today card "going out"
  Expected: the started chat with its answer, the draft, the model pick and the approval mid-hold are all intact, and the hold still ends on the clock
  Covered:  e2e/demo-upgrade.spec.ts

Navigation: palette and shortcuts
  Path:     Cmd+K or Search -> type
  Selector: palette, shortcuts Cmd+Shift+O, Cmd+\
  Expected: pages, settings pages and chats open; Escape returns focus; shortcuts skip fields except Cmd+K
  Covered:  e2e/navigation.spec.ts

Palette: theme switch
  Path:     Cmd+K -> Switch to dark theme (or light); Settings -> General -> Theme
  Selector: palette item, Theme dropdown, root `dark` class, body colour
  Expected: the palette item flips light and dark, and Settings adds System (follows the OS setting live); each sets the class and the page colour, is saved in `inhouse.theme` (System saves nothing) and survives a reload
  Covered:  e2e/palette-theme.spec.ts

Palette: Report a bug
  Path:     Cmd+K -> Report a bug
  Selector: option "Report a bug", team window Send
  Expected: the window opens on the bug type; Send waits for words; sending closes the window, shows "Bug sent to your Inhouse team. Thank you." and lists the report among the open requests (the account menu's item opens it: `tour.spec.ts`)
  Covered:  e2e/report-bug.spec.ts

Sidebar
  Path:     sidebar -> collapse
  Selector: collapse button, rail tooltips
  Expected: collapses to a rail, stays collapsed after a reload, expands with the shortcut
  Covered:  e2e/navigation.spec.ts, e2e/models-and-scroll.spec.ts

Account menu
  Path:     sidebar -> account and settings
  Selector: menu "Account", items Your settings, Team settings, Help and guides, Report a bug, Send feedback, Sign out
  Expected: Your settings opens General and Team settings Stage and plan (on a phone the settings menu first); Send feedback opens the team window on Feedback with an empty field and no screenshot box; Report a bug opens it on the bug type; Sign out says it isn't connected
  Covered:  e2e/help-account-menu.spec.ts, e2e/report-bug.spec.ts, e2e/tour.spec.ts, e2e/sample-data.spec.ts, e2e/phone.spec.ts, e2e/overlays-keyboard.spec.ts

Help and guides
  Path:     account menu -> Help and guides
  Selector: dialog "Help and guides", guide buttons, button "Ask the team"
  Expected: one guide open at a time and its text shows; Ask the team swaps Help for the team window on Feedback with "I have a question: " written, and the sent question is listed and survives a reload; by keyboard it opens quiet and Escape gives focus back; on a phone it fits 390
  Covered:  e2e/help-account-menu.spec.ts, e2e/sample-data.spec.ts, e2e/overlays-keyboard.spec.ts, e2e/cross-screen.spec.ts, e2e/no-persona.spec.ts, e2e/settings-pages-phone.spec.ts

Problem panel
  Path:     Today or Approvals -> a card
  Selector: panel dialog, Approve, Edit, Don't send, Ask <approver>, Manage, "Ask about this…"
  Expected: the approval actions as in Approvals above; Ask <approver> says it isn't connected; Ask about this… (in the panel and the card menu) starts a chat holding the question that a reload keeps; Manage on a memory note opens Team memory
  Covered:  e2e/problem-panel.spec.ts, e2e/today-approvals.spec.ts, e2e/app.spec.ts, e2e/page-actions.spec.ts, e2e/sample-data.spec.ts, e2e/phone.spec.ts

Trace window
  Path:     an answer's steps line, or an Activity row
  Selector: dialog "What your Inhouse agent did", radio "Technical", button "Replay", `trace-row`
  Expected: the plain view shows the question and the time with no model or token words; Technical shows tokens; Replay is clicked, its result not asserted; an answer sent mid-run opens its own steps
  Covered:  e2e/app.spec.ts, e2e/conversation-polish.spec.ts, e2e/no-persona.spec.ts, e2e/overlays-keyboard.spec.ts

Notifications and team window
  Path:     bell -> a line; Message the team
  Selector: bell count, window Send
  Expected: reading a line drops the count, Mark all as read empties it; Send waits for words and carries the name from Settings
  Covered:  e2e/navigation.spec.ts

Crashes and error reports
  Path:     ?demo&crash=screen (a screen throws), ?demo&crash=rejection; /api/client-error, /api/unknown
  Selector: alert "Something went wrong." in main, Try again, Message the team
  Expected: a broken screen shows its own boundary and the shell keeps working; Message the team opens Report a bug with a line about the crash; each error sends one scrubbed report (no query, hash, email or token) with the release; other /api paths are 404 with the _headers security headers; no .map is served
  Covered:  e2e/client-errors.spec.ts

Route titles and focus
  Path:     sidebar -> any page; a deep link; the first load
  Selector: document.title, the page's h1
  Expected: the tab reads "<Page> · Inhouse" (Settings pages "<Page> · Settings · Inhouse"); a route change focuses the h1 and the first load leaves focus alone; a heavy page loads its own chunk on first visit and a deep link opens it directly; an in-page hash change leaves focus where the person put it
  Covered:  e2e/route-title-focus.spec.ts, e2e/route-title-focus-phone.spec.ts, e2e/route-chunk-failure.spec.ts

Old tab after a deploy
  Path:     a lazy page whose chunk fails to load
  Selector: the composer draft, alert "Something went wrong.", Reload
  Expected: the tab reloads once into the page and keeps the draft, without showing the crash screen; a second failure within 30 s shows the error screen with Reload instead of looping; offline it shows the error screen and doesn't reload
  Covered:  e2e/route-chunk-failure.spec.ts, e2e/route-title-focus.spec.ts

Content Security Policy
  Path:     every page any spec opens
  Selector: `securitypolicyviolation` events, the CSP response header
  Expected: no page reports a CSP violation and every app document carries the enforced CSP; menus, dialogs and the phone scroll lock work under it
  Covered:  every spec in e2e/, through the `test` fixture in e2e/csp.ts

Keyboard and focus
  Path:     Tab through the shell and overlays
  Selector: Skip to content, F6
  Expected: Skip to content is the first stop; overlays give focus back on close; no page drops focus to the document, including an account-menu pick that closes the phone drawer
  Covered:  e2e/overlays-keyboard.spec.ts, e2e/chats-manage.spec.ts, e2e/cross-screen.spec.ts, e2e/account-menu-focus-phone.spec.ts

Scenarios and stages
  Path:     demo switcher -> every Stage and Scenario
  Selector: Stage, Scenario
  Expected: every page opens with no crash, console error or other state's data; First day and Loading show their own empty looks (Routines, Skills, Tools, Usage, Activity and the audit log each a real state); Cap reached shows the banner
  Covered:  e2e/data-states.spec.ts, e2e/tour.spec.ts, e2e/app.spec.ts, e2e/pages-polish.spec.ts, e2e/pages-polish-phone.spec.ts

Memory across reloads
  Path:     change something -> reload -> Reset demo
  Selector: Reset demo
  Expected: drafts, started chats, model pick and Library view survive a reload; Reset demo puts Act and Normal back; old saved values load cleanly
  Covered:  e2e/memory.spec.ts, e2e/state.spec.ts

Phone layout (390)
  Path:     every page at 390x844
  Selector: sidebar, composer, menus, toasts
  Expected: nothing cut or covered; tap targets are tap-size; toasts sit above the composer
  Covered:  e2e/phone.spec.ts, e2e/chats-manage-phone.spec.ts, e2e/composer-phone.spec.ts, e2e/conversation-phone.spec.ts, e2e/dots-and-today-phone.spec.ts, e2e/models-and-scroll-phone.spec.ts, e2e/navigation-phone.spec.ts, e2e/page-actions-phone.spec.ts, e2e/page-details-phone.spec.ts, e2e/pages-polish-phone.spec.ts, e2e/settings-pages-phone.spec.ts, e2e/slack-channel-phone.spec.ts, e2e/text-fit-phone.spec.ts, e2e/today-approvals-phone.spec.ts

Visual and a11y
  Path:     every state in `e2e/states.ts`
  Selector: screenshot, axe
  Expected: visual shots match the Linux baselines in light and dark; axe finds no new WCAG 2.1 A or AA issue
  Covered:  e2e/visual.spec.ts, e2e/a11y.spec.ts

Motion (30 fps)
  Path:     send, stream and finish an answer
  Selector: every animation frame's scrollTop, scrollHeight and last message bottom
  Expected: the view never jumps up and the bottom gap never jumps
  Covered:  e2e/motion.spec.ts (manual only: `MOTION=1`, the `motion` workflow; not in CI's normal run)

Sample data rules
  Path:     the data files
  Selector: n/a
  Expected: no 24-hour time, UK spelling, old dates or the words sample, demo or mock in text a person reads; no persona name from the old build
  Covered:  e2e/sample-data.spec.ts, e2e/no-persona.spec.ts
