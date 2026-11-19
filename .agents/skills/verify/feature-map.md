Status: draft, waiting for Wasim's approval (2026-11-19).

# Inhouse feature map

Format and workflow: global `verification` skill, `references/feature-map.md`. Each entry says `covered` (a spec drives it, named in brackets) or `gap` (no spec). Seed every path with `?demo` at Stage Act and Scenario Normal unless it says otherwise (see [SKILL.md](SKILL.md)). Gaps are listed first.

## Gaps (no spec yet)

- Palette action "Report a bug" (only opened by the tour), and the palette's theme switch (light, dark, system).
- Read aloud on an answer, dictation in the composer, Google Drive and asking in Slack stubs (each says it isn't connected).
- Settings pages that only the tour and the no-persona sweep open, with no behaviour checked: Stage and plan, Team memory, Run limits.

## Today

Today: needs-you cards
  Path:     Today
  Selector: article cards, button "Review"
  Expected: only the title, the composer and the Needs you cards show, at every stage; no card cuts text  [covered: dots-and-today, today-approvals]

Today: snooze and dismiss
  Path:     Today -> card "···" menu -> Snooze or Dismiss
  Selector: card menu items, Approvals badge
  Expected: the card leaves Today and Approvals, the badge agrees, a reload keeps it, Reset demo clears it  [covered: page-actions]

Today: open a card
  Path:     Today -> click the card
  Selector: one real button per card, the "···" menu is separate
  Expected: the problem panel opens; the menu doesn't open it  [covered: today-approvals]

Today: sort at Run
  Path:     Today at Run -> Biggest amount first
  Selector: sort control
  Expected: handled cards stay after the cards that need you  [covered: cross-screen]

Today: composer logo row
  Path:     Today -> composer
  Selector: tool logos, "+N" chip
  Expected: 3 logos, a +N chip for the rest, and the count is real  [covered: dots-and-today]

## Approvals

Approvals: approve, edit, Undo
  Path:     Today -> Review -> Approve and send (or Edit first)
  Selector: panel button "Approve and send to Kestrel", toast "Undo"
  Expected: "goes out in 10 seconds" toast; Undo inside the hold cancels the send; a reload during the hold still sends it; Reset demo during the hold sends nothing  [covered: app, state, page-actions]

Approvals: a draft with no text
  Path:     Approvals -> Edit on a draft with no text
  Selector: note field in the panel
  Expected: the panel opens on a note field and the note survives approve and Undo  [covered: today-approvals]

Approvals: approve all low-risk
  Path:     Approvals -> Approve all low-risk
  Selector: button "Approve all low-risk", toast "Undo"
  Expected: three drafts approved, one Undo takes all three back  [covered: today-approvals, toasts]

Approvals: Don't send and sort
  Path:     Approvals -> Don't send, sort control
  Selector: card menu, sort
  Expected: card leaves with an Undo; sort reorders; counts leave set-aside problems out  [covered: page-actions]

Approvals: loading and first day
  Path:     Approvals at Loading and First day
  Selector: status text
  Expected: loading status, no sort, no approve-all, no cut text  [covered: today-approvals]

Toasts
  Path:     approve twice, delete two routines, hover, F6
  Selector: `[data-toast]`, role "status"
  Expected: two approvals share one toast with one Undo; at most four toasts; a held approval is never pushed out; hover pauses the countdown; focus moves to the next toast then the page  [covered: toasts]

## Chats and conversation

Chat: ask a question
  Path:     Today or a chat -> composer -> Send
  Selector: composer field, Send, Stop
  Expected: the stuck-orders question gives the same table and a 6-step, 9.4 s trace; Stop ends the run and says nothing was changed; Send is off while the field is empty  [covered: app, composer]

Chat: composer files
  Path:     composer -> paste or drop files
  Selector: file chips
  Expected: chips appear; a file over the limit says why and isn't added; each chat keeps its own draft and files  [covered: composer]

Chat: answer actions
  Path:     answer -> Copy, Edit, Regenerate, thumbs, steps
  Selector: answer row buttons
  Expected: markdown renders, Jump to latest appears when scrolled up mid-stream, steps open the trace  [covered: conversation, conversation-polish]

Chat: queue and edit
  Path:     send two messages mid-answer, Edit a question
  Selector: queued message, "Editing" label, Retry
  Expected: queued messages wait and send in order, Stop pauses the queue, Escape in an edit restores the draft  [covered: conversation-polish]

Chat: runs in the background
  Path:     start an answer -> open another chat or the Library -> come back
  Selector: sidebar running dot
  Expected: the whole answer is there once; deleting a chat stops its run and Undo brings it back with a stopped note  [covered: run-lifecycle]

Chat: See all and management
  Path:     sidebar -> See all (`#/chats/all`)
  Selector: search box, row menu, Select
  Expected: search filters by title; rename, pin, copy link, delete with Undo, bulk delete; a reload keeps it until Reset demo  [covered: chats-manage, sample-data]

Chat: links
  Path:     `#/chats/<id>`, an unknown id or page
  Selector: URL
  Expected: Back and Forward move between chats; an unknown link lands where it would anyway and says so  [covered: cross-screen, mock-behaviour, state]

Chat: mock answers
  Path:     ask a routine request or an off-script question
  Selector: routine row, suggestion chips
  Expected: a schedule and a time make one routine; an off-script question gets "can't answer from your tools yet" with chips  [covered: mock-behaviour]

## Library

Library: browse and filter
  Path:     Library (`#/library`)
  Selector: tabs, places panel, search, view switch
  Expected: tabs and places filter with matching counts; search has an empty state with Clear; masonry, grid and list show the same files  [covered: library, library-polish]

Library: viewer
  Path:     Library -> open a file
  Selector: viewer window, link back to the source
  Expected: the viewer opens, its link goes to the chat, routine or approval, arrow keys step through files, Back closes it  [covered: library, library-polish, page-details]

Library: select and delete
  Path:     Library -> Select -> Delete
  Selector: confirm dialog, toast "Undo"
  Expected: delete asks first, Undo restores, the delete survives a reload  [covered: library, cross-screen]

## Routines, Activity, Tools, Skills, Usage

Routines: details and actions
  Path:     Routines -> a routine
  Selector: switch "<name> on or off", Pause, Run now, Delete
  Expected: details show; Delete asks and Undo works; all of it survives a reload; at Watch a routine is locked and shows its stage  [covered: page-details]

Activity: log
  Path:     Activity
  Selector: rows, times
  Expected: every time sits on one line; the Klaviyo line takes its date from the data  [covered: sample-data]

Tools: list and pages
  Path:     Tools (`#/tools`) -> a tool
  Selector: search, Pause access, Reconnect, Request a tool
  Expected: pausing or disconnecting changes the count, the tool page and the composer alike; Pause access has Undo; Request a tool opens the team window  [covered: data-states, page-actions]

Tools: Slack channel
  Path:     Tools -> Slack
  Selector: Slack row
  Expected: its own page with channel details and no tool abilities; before Act it says "included from Act"; Back returns to Tools  [covered: slack-channel]

Skills
  Path:     Skills -> a skill
  Selector: switch in details
  Expected: turn a skill off and back on; search filters the list  [covered: page-details, sample-data]

Usage
  Path:     Usage
  Selector: month picker, daily bars
  Expected: totals agree in every breakdown; bars are one tab stop with arrow, Home and End; a cap below spend shows the capped state  [covered: app, page-actions, edge-cases]

## Settings

Settings: dropdowns and fields
  Path:     Settings -> any page
  Selector: dropdown, text field, search
  Expected: a dropdown opens a real list, works by keyboard, Escape cancels; a pick survives a reload and Reset demo clears it; text fields save and show in the account menu  [covered: sample-data, menus]

Settings: Models
  Path:     Settings -> Models
  Selector: effort picker, on switch
  Expected: Max, Smart (default), Fast, Instant; switching one off hides it; effort persists  [covered: models-and-scroll]

Settings: Members and approvers
  Path:     Settings -> Members, Who approves what
  Selector: role control, Remove
  Expected: removing Admin asks first; a demoted approver stays on rules that name them with a tag; a wrong cap shows why and isn't saved  [covered: page-details, edge-cases, cross-screen]

Settings: photos
  Path:     Settings -> General -> photo
  Selector: upload, Remove
  Expected: the photo shows in the sidebar, account menu, Members, Activity and Usage; bad files give an error toast; reset clears it  [covered: photo]

## Shell and states

Navigation: palette and shortcuts
  Path:     Cmd+K or Search -> type
  Selector: palette, shortcuts Cmd+Shift+O, Cmd+\
  Expected: pages, settings pages and chats open; Escape returns focus; shortcuts skip fields except Cmd+K  [covered: navigation]

Sidebar
  Path:     sidebar -> collapse
  Selector: collapse button, rail tooltips
  Expected: collapses to a rail, stays collapsed after a reload, expands with the shortcut  [covered: navigation, models-and-scroll]

Notifications and team window
  Path:     bell -> a line; Message the team
  Selector: bell count, window Send
  Expected: reading a line drops the count, Mark all as read empties it; Send waits for words and carries the name from Settings  [covered: navigation]

Keyboard and focus
  Path:     Tab through the shell and overlays
  Selector: Skip to content, F6
  Expected: Skip to content is the first stop; overlays give focus back on close; no page drops focus to the document  [covered: overlays-keyboard, chats-manage, cross-screen]

Scenarios and stages
  Path:     demo switcher -> every Stage and Scenario
  Selector: Stage, Scenario
  Expected: every page opens with no crash, console error or other state's data; First day and Loading show their own empty looks; Cap reached shows the banner  [covered: data-states, tour, app]

Memory across reloads
  Path:     change something -> reload -> Reset demo
  Selector: Reset demo
  Expected: drafts, started chats, model pick and Library view survive a reload; Reset demo puts Act and Normal back; old saved values load cleanly  [covered: memory, state]

Phone layout (390)
  Path:     every page at 390x844
  Selector: sidebar, composer, menus, toasts
  Expected: nothing cut or covered; tap targets are tap-size; toasts sit above the composer  [covered: the `*-phone` specs, text-fit-phone]

Visual and a11y
  Path:     every state in `e2e/states.ts`
  Selector: screenshot, axe
  Expected: visual shots match the Linux baselines in light and dark; axe finds no new WCAG 2.1 A or AA issue  [covered: visual, a11y]

Sample data rules
  Path:     the data files
  Selector: n/a
  Expected: no 24-hour time, UK spelling, old dates or the words sample, demo or mock in text a person reads; no persona name from the old build  [covered: sample-data, no-persona]
