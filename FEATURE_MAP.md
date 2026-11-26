# Inhouse feature map

Every screen, flow, selector, expected behavior, and E2E spec coverage in one place. Read the relevant section before changing a screen, user flow, or spec, and update its `Expected:`, `Covered:`, or `Gaps` lines in the same PR for any user-facing change. Each entry uses four fields (`Path`, `Selector`, `Expected`, `Covered` or `gap`). Unless noted, demo paths start at `?demo` with Stage Act and Scenario Normal (see [VERIFY.md](VERIFY.md)). Gaps are listed first.

## Gaps

No entry is `Covered: gap`. Not checked by any spec, or only in part:

- Motion: `e2e/motion.spec.ts` is manual only (`MOTION=1`, the `motion` workflow), never in CI's normal run.
- Ship specs: `e2e/ship/agent-seam.spec.ts`, `e2e/ship/example.spec.ts`, `e2e/ship/setup-gaps.spec.ts`, `e2e/ship/hardening.spec.ts` and `e2e/ship/backend-core.spec.ts`, `e2e/ship/agent-chat.spec.ts`, `e2e/ship/memory-skills.spec.ts` (projects `ship-desktop` and `ship-phone`) are manual only, run by `ship.yml` against a PR's preview (`backend-core.spec.ts`, `agent-chat.spec.ts` and `memory-skills.spec.ts`: on the test build, `build=test`), never in CI's normal run.
- Trace window: the Technical `CodeBlock` badges (`cut`, `denied`) aren't shown by any spec: they come from a product step's `io`, which the demo's recorded traces don't carry and the test build can't make without a container turn.
- Command palette: no spec opens it before the idle prefetch has loaded its chunk; in that moment (up to about 4 s after a load) keys typed straight after Cmd+K land in what had focus, and Escape reaches the page under it.
- Settings > General: Language and Text size are opened and closed by `menus.spec.ts`, but no spec picks one and checks it saves.
- Icons: the fallback glyph for a name outside the manifest is drawn by `src/ui/index.tsx` but no spec checks it; a name
  missing from the font fails lint (`scripts/check-icons.mjs`), not a spec.
- Connector hub (`app/hub/`, P4-P5): no screen. Its default export answers 404 to every request and it has no public route (`hub/index/index.workers.test.ts`); it answers only the product Worker's service bindings (`HUB` / `ReadGateway`, `HUB_CONNECT` / `ConnectGateway`, `HUB_DELIVERY` / `DeliveryGateway`, `HUB_WRITE` / `WriteGateway`; writes run only in the test build, against fake upstreams, in Stage 1: `hub/outbox-entry/*.test.ts`); the `hub` CI job and test-build connector specs (`e2e/api/{connect,tools,notify-slack,canary,notices-injection}.spec.ts`) run its checks. Transient MCP startup retries, including a thrown hub tool-list RPC, are covered by runner proxy and egress unit tests.
- Export everything downloads invented data in the demo. Sign out is a demo stub: specs check it says so and changes nothing. In the product Sign out goes to Access's logout; `e2e/real/sign-out.spec.ts` checks the account menu goes to that path on the test build (no Access there); the real Access logout is checked on the candidate deploy (pending).
- The chat WebSocket under the enforced CSP (`e2e/real/socket-csp.spec.ts`) needs a run, so it is checked on the sandbox deploy (`E2E_TEST_BUILD_REMOTE=1`), not on the local test build, which has no container. `e2e/real/csp-download-photo.spec.ts` covers the audit CSV download and a member photo on both.
- A failed or never-run chat turn's words after a reload (its stored end row, P3) and a trace's "up to" cost while a model call is open are proven only by unit tests (`server/do/brand-agent/projection.test.ts`, `src/screens/chat/history.test.ts`, `src/lib/trace-cost.test.ts`): the test build has no container and no way to force a placement failure or hold a call open without new test code in the deployable bundle.
- Brand skills (P6a): making and changing one through `skill_save` in a chat runs only on the container deploy (`e2e/api/brand-skills.spec.ts`'s chat part); that a skill loads as `brand:<name>`, is read when used and can't be written by the session is the runner job's container probe (`brand-skills.*` in `app/runner/image/probes/run.ts`). The read-side cases RS-KW1 and RS-KW2 (a skill's body that tries to widen tools or send data out) are wired into the product target, with fixture setup and cleanup covered by a unit test. Paid model results are pending.
- The outbox (Stage 1 M2-B, M2-H): routes 120 to 124 have their screens (Approvals' action cards, the chat's `ask` part, Activity's action rows) and client methods. Writes stay off: no operation is enabled in a deployable build, so the product's lists are empty; on the test build the fakes hook's `ceiling` and `action` ops (`e2e/api/fakes-kit.ts`) put cards in front of the screens (`e2e/real/actions-ui.spec.ts`). The hold, the claim, Undo, Pause, the sweep and "Needs a check" are proven by `server/outbox/*.test.ts` and its property suite; the route spec (`e2e/api/routes.spec.ts`) checks who may call each route. The write-safety gate (Stage 1 M2-S): `server/outbox/write-safety.property.test.ts` runs random requests, answers, Undo, withdrawals, permission removals, role and member changes, ceiling and account changes, Pause and Resume, clock jumps, crashes at each dispatcher boundary and every upstream fault through the real outbox, claim and dispatcher into the hub's own write entry and fake write store, and checks every effect in the store's log against a live permission or an approval of that exact revision; `e2e/api/actions.spec.ts` sends through the test build's real routes and BrandAgent's alarm into the hub's fake write store (the product's state refuses every request; a card is its asker's; Undo before the claim sends nothing; a send happens once, after the hold; Pause sends approvals back to waiting and Resume sends nothing; a refusal fails and an unclear answer needs a check that an admin resolves; removing a permission or turning the operation off before the claim stops the send). Specs set the ceiling only through the hook.
- Stage 1 M2-H, not checked in a browser: the chat's `ask` part (an action card inside an answer) and `action.updated` reaching it need a container turn that proposes an action (M2-D wires the agent's tools), so they are proven by `src/screens/chat/AskCard.test.ts` and `src/agent/http/actions.test.ts`; the Questions section on Approvals needs a container turn to ask (`question_ask`, offered to the agent in every build since M2-H: `server/questions/switch.ts`), so it is proven by `src/screens/approvals/agent-asks.test.ts` and the sandbox's `e2e/api/questions.spec.ts`; the screens' visual baselines are only the demo's (`baselines.yml` runs `visual.spec.ts`, which doesn't open the test build), so the test build's screens are proven by named screenshots, axe and a no-sideways-scroll check in both themes, in `e2e/real/actions-ui.spec.ts`.
- Asks in the agent's flow (Stage 1 M2-D, N14): no screen of its own (M2-H's cards show the chat's `ask` part). The agent's write tools are a third MCP server (`actions`, on the egress's `/actions/`), given to a run only while an operation is enabled for the brand (none in a deployable build, so the product's runs never see it). Each call is admitted only as an unused call of that tool, with that input, by the main agent in a live turn (BrandAgent's `tool_invocations`, from the audit hook), goes through the outbox's `request`, adds the turn's `ask` part and waits up to 2 minutes (30 s more once approved; 3 waits per turn; a job's or a routine's turn never waits); a later answer reaches the agent through a resume turn keyed `act_<id>`, which stays off until M2-G wires the action texts. `approval_request` is admitted the same way, and a routine's run asks the routine's creator. The egress's `/hub/` runs only what the hub's read list names (the stage gate is gone). Each request copies the hub's connection date and the Shopify write store's handle into `connector_accounts`; a deleted chat withdraws its waiting and approved actions; a card names the permission an action ran under. Proven by `server/egress/actions*.test.ts`, `server/do/brand-agent/asks*.test.ts` (the `report` property included), `hub-accounts.test.ts`, `run-start-actions.test.ts`, `server/outbox/chat-deleted.test.ts`; on the test build the fakes hook's `action` op drives the real `/actions/` handler with a stand-in admission (no container), and `e2e/api/actions.spec.ts` sends both writes (a Shopify tag and a Slack post to a listed channel) end to end into the fake upstreams. A container run of the scripted `action-tag-add` and `action-approval-request` scenarios (`test/scripted-model/scenarios/actions.ts`) runs on the sandbox deploy only.
- "A failed audit write leaves no change" (Acceptance 6) is proven only by the server unit tests on the vitest workerd (compat 2026-11-11), not on the test build's: forcing an audit write to fail there needs test code in the deployable bundle.

## Today

In the product build Today, Activity, the bell, the Library and Routines are real, backed by the API (P4 routes 52 to 66, and route 86 for a routine's own runs), not demo data. The `?demo` entries below describe the demo build. Product proof: `e2e/api/{today,activity,bell,library,routines}.spec.ts` on the test build and the ship spec `e2e/ship/watch.spec.ts` (S1 to S8).

Today: needs-you cards
  Path:     Today
  Selector: article cards (two columns on desktop, one on a phone), "Urgent" pill, draft sheet, button "Review draft" or "{cta}"
  Expected: only the title, the composer and the Needs you cards show, at every stage; no card cuts text; a waiting card shows its draft on the slate-sapphire sheet (kind, risk, title, one summary line); approved, handled and Watch cards show the status line instead, muted, with no Urgent pill; with zero problems and tools connected, shows connected tools (no status dots) and prompt cards instead of the set-aside message; in Run, the "{N} handled today" strip shows only when at least one job was handled; the greeting follows the app's clock (Good morning 5:00 to 11:59, Good afternoon 12:00 to 16:59, Good evening otherwise; Welcome on day one) and a clear day reads "You're all caught up."
  Covered:  e2e/dots-and-today.spec.ts, e2e/today-approvals.spec.ts, src/state/today-empty.test.ts, src/state/derive.first-day.test.ts

Today: failed morning check (product)
  Path:     Today before the current day's morning check has run or is late
  Selector: the check's "didn't finish" card
  Expected: if the previous local date's latest check failed, its card is still visible (before the deadline on a due day, all day on a day off, never from two days back, never with no routine). A morning with no known failure stays empty before the deadline. After the deadline, a missing check shows the usual "hasn't run today" card.
  Covered:  server/today/view.test.ts

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
  Expected: 3 logos, a +N chip for the rest, and the count is real (in the button's name); the label is written out only when it says what the logos can't: no tools connected, some off in this chat, or some not read yet
  Covered:  e2e/dots-and-today.spec.ts

## Approvals

Approvals: approve, edit, Undo
  Path:     Today -> Review draft -> Approve and send (or Edit first)
  Selector: panel button "Approve and send to Kestrel", toast "Undo"
  Expected: "goes out in 10 seconds" toast; Undo inside the hold cancels the send; a reload during the hold still sends it; Reset demo during the hold sends nothing
  Covered:  e2e/app.spec.ts, e2e/state.spec.ts, e2e/page-actions.spec.ts

Approvals: a draft with no text
  Path:     Approvals -> Edit on a draft with no text
  Selector: note field in the panel
  Expected: the panel opens on a note field and the note survives approve and Undo
  Covered:  e2e/today-approvals.spec.ts

Approvals: draft cards
  Path:     Approvals
  Selector: one card per draft: "Urgent" pill, risk tag ("Spends $9,600", "Claims $1,240", "Goes to customers", "Low risk", "Needs review"), "{area} · {time}", draft text on the sheet, approver line, "Review draft" or the one-tap approve, button "More" ("More actions for {draft}": menu "Draft actions" with Don't send first, then Review on a low-risk draft, then Edit), "From {sources}"
  Expected: one column; "Review draft" opens the review window, which steps through the waiting drafts in the page's order; Escape on More closes the menu only; on a phone the tags sit above the title, detail rows stack and the primary is full width beside More; in Watch, list rows omit `$0` when there is no money at stake (`hasAmount`)
  Covered:  e2e/today-approvals.spec.ts, e2e/today-approvals-phone.spec.ts, e2e/ship/needs-you-cards.spec.ts

Approvals: approve all low-risk
  Path:     Approvals -> Approve all low-risk
  Selector: button "Approve all low-risk" with its count, toast "Undo"
  Expected: three drafts approved, one Undo takes all three back
  Covered:  e2e/today-approvals.spec.ts, e2e/toasts.spec.ts

Approvals: Don't send and sort
  Path:     Approvals -> More -> Don't send, sort control
  Selector: card's More menu, sort
  Expected: card leaves with an Undo; sort reorders; counts leave set-aside problems out
  Covered:  e2e/page-actions.spec.ts

Approvals: loading and first day
  Path:     Approvals at Loading and First day
  Selector: status text
  Expected: loading status, no sort, no approve-all, no cut text
  Covered:  e2e/today-approvals.spec.ts

Approvals: the agent's actions and questions (Stage 1 M2-H, the product)
  Path:     test build -> sign in -> Approvals (a card seeded through the fakes hook's `action` op; a question the agent asked with `question_ask`, routes 140 and 141)
  Selector: sections "Questions for you", "Actions for you" and, for an admin, "Waiting on your team" (members' cards; each with its count) above the drafts; a card `[data-action-card="<state>"]` (`role="group"` named by its title): kicker, title, the server's lines, facts (tool, records, "Reaches customers", "Can't be taken back", the guardrail), `[data-card-actions]` buttons, Open (only for a chat the viewer may open), the hold's `role="timer"`; a question `[data-question]` with one button per option
  Expected: the buttons follow the card's `can` and kind only (N15): an ask card offers Allow once, Always allow and No (Always allow first when the server nudges it), an exact one Approve and No, the hold Undo with "Goes out in N seconds" counted from the server's `sendAt` and `serverNow` (never the browser's clock), "Needs a check" offers It went out and It didn't go out to its approver or an admin; an admin sees a member's card's facts under "Waiting on your team" ("Waiting for {name}"), with no button and no Open; each answer sends the rev the card was read at (once, however often it's clicked), shows the card after it and a toast, and keeps focus on the card's title; a conflict shows the card as it is now with "This changed before your answer arrived. Here it is now." (with no card in the refusal, or any other refusal, the card reads itself again; a card gone offers no button); Undo after Always allow says Always allow stays on and where to remove it; at the hold's end the card reads itself every 2 s, then more slowly up to every 30 s, until it settles, on through failed reads, and an `action.updated` for it reads it again; a card that can't be read first offers Try again; a question's answer is the option's own text, then "You answered: X" (or "Someone answered first: X", or that the agent stopped waiting), and a lost delivery offers Try again with the same answer; with no actions and no questions (the demo) nothing is added and the page looks as before; the Inhouse team reads nothing and sees none of it
  Covered:  e2e/real/actions-ui.spec.ts (desktop and phone, axe and screenshots in light and dark), src/screens/chat/AskCard.test.ts, src/screens/chat/ask-card.property.test.ts, src/screens/approvals/agent-asks.test.ts, src/agent/http/actions.test.ts, src/agent/contract/agent.contract.test.ts (real target)
  Gaps:     the Questions section isn't driven in a browser (see Gaps above)

Toasts
  Path:     approve twice, delete two routines, hover, F6
  Selector: `[data-toast]`, role "status"
  Expected: two approvals share one toast with one Undo; at most four toasts; a held approval is never pushed out; hover pauses the countdown; focus moves to the next toast then the page
  Covered:  e2e/toasts.spec.ts

## Chats and conversation

The entries below are the demo's chat (the mock agent). The product's chat, on the real client, is the last entry of this section.

Chat: ask a question
  Path:     Today or a chat -> composer -> Send
  Selector: composer field, Send, Stop
  Expected: the stuck-orders question gives the same table and a 6-step, 9.4 s trace; Stop ends the run and says nothing was changed; Send is off while the field is empty
  Covered:  e2e/app.spec.ts, e2e/composer.spec.ts

Chat: empty chat tool status
  Path:     New chat with no messages
  Selector: copy and action under "What should we look into?"
  Expected: if tools exist but none can be read, the empty chat uses the same message as the composer tools menu and offers Manage tools. Connect tools is only for when no tools have been connected.
  Covered:  src/screens/Chats.test.ts

Chat: composer files
  Path:     composer -> paste or drop files
  Selector: file chips (`[data-slot=attachment]`; a rejected one is `data-state="error"` with `data-rejected`, inside one `role="alert"`)
  Expected: chips appear (base `Attachment`, small, in the composer's top addon); a file over the limit says why and isn't added; each chat keeps its own draft and files. The composer is an `InputGroup` (`[data-composer]`): its field is the group's control, so the card takes the focus look while the field has focus, and the dashed border shows while files are dragged over it
  Covered:  e2e/composer.spec.ts, src/ui/attachment-chip.test.ts

Chat: Google Drive and Slack stubs
  Path:     composer -> Attach -> From Google Drive; answer -> More -> Send to Slack
  Selector: menuitem "From Google Drive", menuitem "Send to Slack", toast
  Expected: demo-only Attach items (`From Google Drive`, `Screenshot of this page`) and `Send to Slack` in the demo say "<What> isn't connected in this demo." and change nothing; the approver's "Ask Leo" button says the same (`sample-data.spec.ts`). In the product build `From Google Drive` and `Screenshot of this page` are hidden (`src/lib/product-flow.ts`)
  Covered:  e2e/not-connected-stubs.spec.ts, src/lib/product-flow.test.ts, e2e/real/product-hides.spec.ts (the product's Attach menu has Upload files and neither stub)

Chat: Dictate
  Path:     composer -> Dictate
  Selector: button "Dictate", toast
  Expected: in the demo it says "Dictation isn't connected in this demo." and leaves the field alone; hidden in the product build until dictation is wired (`src/lib/product-flow.ts`)
  Covered:  e2e/not-connected-stubs.spec.ts, src/lib/product-flow.test.ts, e2e/real/product-hides.spec.ts (no Dictate beside Attach in the product, on a computer)

Chat: answer actions
  Path:     answer -> hover or Tab into the row -> Reply, Copy, Regenerate, thumbs, More; More -> Send to #channel, Report a wrong answer, Delete
  Selector: answer row buttons, `[data-answer-actions]`, menu "Message actions"
  Expected: at rest every answer (the newest too) hides its actions; hover or keyboard focus shows them and an open More menu keeps them; in the demo the menu has Send to #channel (when a channel is connected), Report a wrong answer and Delete, and the row includes Good/Bad answer thumbs; in the product build per-message `Delete` and `Good answer` / `Bad answer` are hidden (`src/lib/product-flow.ts`); the phone row is Copy and More; markdown renders on Streamdown, loaded as its own chunk once the browser is idle (until it is there the text shows as plain lines): `#` is an h2 (no h1), a single newline is a line break, `>100` stays text, raw HTML shows as text, a fenced block is the base Code Block in plain text (a keyboard-scrollable region named `Code block N, lang` with its own Copy button, `data-md-code`); code, monospaced text and a diagram's text show `-->` or `=>` as typed (ligatures off), a table is a scrollable region named `Table N: first columns` (`data-md-table`; a row wider than the header widens it), a ` ```mermaid ` fence is a diagram (`data-md-diagram`; Mermaid loads only when one is drawn): a bordered card with the figure as `svg[role=img]` named `Diagram N` inside a keyboard-scrollable region, Show source and Copy, a quiet "Drawing diagram…" line while its fence is open or Mermaid loads, and, if it can't be drawn (or would need HTML labels, or names an address in its style: such a diagram never reaches Mermaid, which lays figures out in the live page), "Couldn't draw this diagram." over its source as a code block; the figure holds no link (a linked node is kept, its link dropped), image, HTML, script, animation or address in its style or attributes, and a diagram's own config can't turn on HTML labels or change the theme or its CSS; a finished answer keeps its drawn figure (no redraw when the answer ends); and half-written markdown (an open fence, a bold, a link) is closed while the answer is still coming; both builds make in-app hash routes and HTTPS destinations on exact hosts explicitly listed in the brand’s WebFetch setting clickable. An empty, missing or invalid list leaves all external destinations as text. External links and images wait for the complete answer. Unlisted images display text and listed images remain subject to the site’s CSP; Jump to latest appears when scrolled up mid-stream (see "Chat: scrolling")
  Covered:  e2e/conversation.spec.ts (including unlisted links in the completed answer), e2e/conversation-polish.spec.ts, e2e/brand-data.spec.ts, e2e/conversation-links.spec.ts (the demo's answer with the WebFetch setting seeded: a listed host's link is clickable in the finished answer, with a new tab and noreferrer; an unlisted host, or only its parent or a sibling listed, stays text), src/lib/product-flow.test.ts. Chat tests parts.test.ts, markdown-links.test.ts and markdown-links.property.test.ts cover WebFetch settings, the streaming gate, link parsing and exact-host matching; `src/screens/chat/markdown/` holds `streamed.property.test.ts` (any prefix of a document renders and keeps the link rules; live and done look the same), `markdown.differential.test.ts` (the old renderer's output on a corpus, with the intended differences pinned) and `build-support/markdown-entry.test.ts` (the renderer stays out of the entry chunk, and Mermaid out of both it and the renderer chunk); diagrams: the last two tests in e2e/conversation.spec.ts (asks for a diagram: the figure is an `svg[role=img]`, inside the column, Show source, and its source code block and figure text compute `font-variant-ligatures: none`; asks for "a diagram ... with links": the demo's hostile sample draws clean, its linked node kept, no request to its addresses, the figure kept when the answer ends), `diagram.test.ts`, `diagram.property.test.ts` (an open fence never draws, with effects), `diagram-engine.test.ts` (draws one at a time), `diagram-svg.test.ts` (hostile figures, jsdom), `diagram-config.test.ts` (the config lock, real Mermaid), `diagram-remount.test.ts` (a finished answer doesn't remount or redraw its diagram), e2e/diagram-states.spec.ts (a fence Mermaid can't parse shows "Couldn't draw this diagram." over its source and logs it; a theme change draws the figure again in the dark colours in the same card, and back), `src/agent/mock-diagrams.test.ts` (the demo's rough diagram fails Mermaid's parser, not the address check).
  Gaps:     the product's own setting (route 11) isn't driven through a browser: a product chat answer needs a container turn, so the link check runs on the demo's saved setting only; a link waiting for the finished answer is not browser-tested (the demo answer shows its link and last words in one step), only the streaming half by parts.test.ts; the product-side hide of per-message Delete and the thumbs isn't checked in a browser (it needs a product answer, a container turn)

Chat: steps, sources and the answer's own cards
  Path:     a finished answer in a chat (`#/chats/stuck`)
  Selector: `[data-steps]` (`TraceCollapsible` button, `aria-expanded`, and Details), `[data-steps-meta]`, `[data-sources]`, `[data-approval]`
  Expected: a finished answer has a collapsed Chain of Thought steps line above its card ("Checked Shopify and ShipBob · 6 steps", or "3 steps" with no check when no connected tool was read; a step that saved or sent something is not "checked") that opens, in place, nested `Trace` rows with tool logos or kind icons and durations, ending with Details and `[data-steps-meta]` (mode and duration only, no timestamp); while streaming, `[data-thinking]` builds progressive `Trace` rows with `AgentMark` and shimmer on the active step; the card ends with one quiet Sources pill ("{N} sources", chevron) that opens a list of internal tool records (no links, no numbered chips, and no pill when the answer cites nothing); a draft to approve is its own card after the answer's card, built on the Confirmation pattern (`Item` with the brand-tint `bg-draft-sheet`, the draft text in its own box, an "Open draft: <title>" link): a low-risk draft shows the main action (e.g. "Approve and send to ShipBob") and "Review and edit", a money or customer draft shows only "Review" (no one-tap approve; both open the review window), and once approved the card shows the approved line with Undo while it can be undone (`[data-approval]` stays on the card); full-shell Skyspace runs hero intensity on Today and blank New chat (with centered composer, 3-column Bento prompt cards and Routine dock, all in place from the first frame of a load: the composer never drops and jumps back) and softly dims behind messages in an active chat; the chat column is 880px
  Covered:  e2e/conversation.spec.ts, e2e/sample-data.spec.ts, e2e/conversation-polish.spec.ts, e2e/dots-and-today.spec.ts, e2e/dots-and-today-phone.spec.ts, e2e/new-chat-reload-layout.spec.ts, e2e/chat-writing.spec.ts (on the page clock: the live steps add one row per step, the newest running with its shimmer and the earlier ones done; the words show at least three at a time with nothing animating; the answer's text is about 620px and your bubble about 520px at 1440; an answer that cites nothing has its steps line and no Sources pill)

Chat: scrolling (Message Scroller, UI_BASE_V2 D1)
  Path:     a chat -> ask a question -> scroll up while it streams -> Jump to latest; Show more on a long message
  Selector: role "log" "Conversation" (`aria-busy` while an answer's words still come), its scroll box (`closest('.overflow-auto')`, role "region" "Messages"), `[data-scroll-anchor="true"]` (the newest question), button "Jump to latest"
  Expected: a chat opens at its last question (at the end when the rest fits); a new question (an ask, Regenerate, Retry, a queued one starting) settles near the top with a peek of the turn before, and its answer grows under it without moving it; once the answer fills the view the view follows the live edge; a scroll up (wheel, touch, keys) holds while the answer streams and shows Jump to latest, which goes back and follows again (pressed from the keyboard, focus moves to the composer as the button goes); opening Show more, an answer's steps or its sources holds the view; Show earlier messages loads above and the view keeps its place
  Covered:  e2e/conversation.spec.ts (scroll up holds, Jump to latest, Regenerate pins the question with no room below), e2e/conversation-polish.spec.ts (Show more holds the view), e2e/motion.spec.ts (MOTION=1 only: the question settles in the top 40%, the pinned question and the view never jump more than 4px, Jump to latest follows to the end)
  Gaps:     Show earlier messages keeping the place isn't browser-tested; a Retry that hides more rows than it adds (question, answer and note) doesn't pin the new question (Message Scroller only anchors a row added past the old count)

Chat: your message
  Path:     a chat -> ask a question (a long one, a reply, with files)
  Selector: `[data-chat-msg]` with `[data-slot=bubble]`, `[data-long-text]`, button "Show more" / "Show less" (aria-expanded, aria-controls), Copy message, Edit message
  Expected: your message is a Message at the end with a Bubble in the app's look (the `bubble` fill, rounded, the reading size, up to the prose measure); a long one shows eight lines with Show more on Bubble's collapsible; Copy and Edit sit beside it on desktop (hover or focus) and under it on a phone or touch screen; files show under it
  Covered:  e2e/conversation.spec.ts, e2e/conversation-polish.spec.ts

Chat: time markers
  Path:     a chat (`#/chats/refunds`), or a new question
  Selector: `[data-thread-marker="time"]` (a Marker separator inside the row it heads)
  Expected: a centred line with the time ("Today 8:03 AM", "Yesterday 8:03 AM", "Mon, Nov 16, 8:03 AM", "Nov 2, 8:03 AM", through `fmtMarkerTime`) before the first message with a time, before any block that starts an hour or more after the last time, and at a day change; the person's message time comes from the `turn.queued` frame (live), `at` on the stored message (history) or the chat's time (sample chats); answers' work rows show no time of their own
  Covered:  src/screens/chat/markers.test.ts (rules and properties: only before a block, never twice in a row, a day change always marks), src/screens/chat/view.test.ts (the question's time), e2e/conversation.spec.ts (one marker heads a new chat, none for a question a minute later), e2e/memory.spec.ts (the marker reads the demo's time after a reload)

Chat: model switch marker
  Path:     a chat -> Model: Smart -> Fast -> ask
  Selector: `[data-thread-marker="model"]`
  Expected: "Switched to <model label>" above an answer turn whose model differs from the answer before it (answers without a model don't count; a change inside one card isn't marked; a model the Models list doesn't name gets no marker, never a raw id)
  Covered:  src/screens/chat/markers.test.ts, e2e/conversation.spec.ts

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
  Expected: search filters by title; rename, pin, copy link, delete with Undo, bulk delete; demo open-chat bar offers Export (hidden in product); a reload keeps changes until Reset demo
  Covered:  e2e/chats-manage.spec.ts, e2e/sample-data.spec.ts, src/lib/product-flow.test.ts
  Gaps:     the product-side hide isn't checked in a browser (the product-flow helpers are plain flags, so dropping a guard at its call site fails no test)

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

Chat: an action card in an answer (Stage 1 M2-H, the product)
  Path:     a product answer whose agent proposed an action (the `ask` part)
  Selector: `[data-action-card]` inside the answer's card
  Expected: the card reads itself (`action(id)`) and is the one Approvals shows (see Approvals above); an `action.updated` for it in the followed run reads it again, one for another card or an older rev doesn't; a card it can't read says so
  Covered:  src/screens/chat/AskCard.test.ts, src/agent/http/actions.test.ts
  Gaps:     no browser spec (it needs a container turn that proposes an action; see Gaps above)

Chat: the product's chat (real client)
  Path:     product build on the test build or the sandbox deploy -> sign in as a seeded member -> a chat -> send, reload, open a second tab
  Selector: composer, Send, Stop, the pause control, `#/usage`
  Expected: the answer streams from the scripted model; a reload or second tab reattaches to the live run from its cursor; send, interrupt and stop act on the turn by id; one writer per chat; pause stops new and live runs and resume starts nothing; history, search, memory notes and attached files come from the server; the Usage page matches the ledger and a reached cap refuses the turn; a socket without a valid session, a wrong `Origin`, or a removed member is closed
  Covered:  e2e/api/chats.spec.ts, e2e/api/runs.spec.ts, e2e/api/socket.spec.ts, e2e/api/live-turns.spec.ts, e2e/api/pause.spec.ts, e2e/api/attachments.spec.ts, e2e/api/memory.spec.ts, e2e/api/usage.spec.ts, e2e/real/socket-csp.spec.ts, e2e/real/composer-no-models.spec.ts, e2e/real/start-errors.spec.ts (the specs that need a run: the sandbox deploy only)

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
  Selector: row switch "<name> on or off"; the side panel: name and what it does, the schedule card (schedule sentence, next run, the same switch, one "how it works" line), Run now, Edit in a chat, "More for <name>" (Delete), list "Last runs" (`data-run-line`: an outcome icon, "Today, <time>" or "<weekday>, <date>, <time>", one plain line, Steps when the run has steps), Made by
  Expected: the panel leads with the schedule sentence and the next run; its switch replaces Pause, says "Off. It won't run until you turn it on." when off and agrees with the row; while the agent is paused both switches still show the routine's own on or off (a click saves the other one) and the pause shows as "Paused" for the next run; Last runs are the routine's own runs from `GET /api/routines/:id/runs` (route 86), newest first, at most 20, never matched from Activity by name: each shows when it ran, done, failed, skipped or running, and one plain line with no run ids, timings, costs or codes; a routine with none says "Not run yet."; a list that can't load says so with Try again (announced; a failed recheck keeps the list); while a run is going the open panel rechecks every 15 s for up to 10 minutes, not while the tab is hidden and never for the Inhouse team; a run stopped on purpose reads as skipped, not failed; Run now lands at the top of Last runs ("Run now · <result>", or "Run now" while it runs; the demo's Run nows finish at once) and survives a reload; Steps opens the trace; Delete (in More) asks and Undo works; all of it survives a reload; at Watch a routine is locked, shows "Starts in Act" and has no Run now. If the server refuses Run now because of the stage, the message directs the person to their Inhouse team
  Covered:  e2e/page-details.spec.ts, e2e/pages-polish.spec.ts, e2e/pages-polish-phone.spec.ts, src/screens/routine-switch.test.ts, src/state/routine-run-lines.test.ts, src/agent/mock.routine-runs.test.ts, src/agent/http/routines.test.ts, server/api/routines.test.ts, server/routines/store.test.ts, e2e/api/routines.spec.ts (route 86), e2e/real/routine-last-runs.spec.ts (the failed, skipped and done icons and lines, and the error line with Try again, on the test build with route 86 answered by the spec)
  Gaps:     no browser spec ends a real run in failure or skipping (the demo's sample runs all finished, and e2e/real/routine-last-runs.spec.ts answers route 86 itself)

Activity: log
  Path:     Activity
  Selector: search "Search activity", radiogroup "Filter activity" (All, Needs you, Changes), a section per day, rows (`data-activity-row`: one icon, the sentence, the time on the right)
  Expected: rows look like All chats' rows (the same icon on every row, no per-kind colours or status words); every time sits on one line; the tabs and the search filter the days, with an empty line for none; the Klaviyo line takes its date from the data
  Covered:  e2e/sample-data.spec.ts, e2e/page-actions.spec.ts, e2e/no-persona.spec.ts, e2e/ui-round-3.spec.ts

Activity: actions (Stage 1 M2-H, the product)
  Path:     test build -> Activity (after an action was answered)
  Selector: section "Actions" above the days, rows `[data-activity-action="<state>"]` ("{title}. {where it got to}", the time), button "Stop allowing this: {title}"
  Expected: the newest 20 actions, under All and Changes (not Needs you) and narrowed by the search; a member's action, seen by an admin, says whose ("Dana Kim said no."); "Stop allowing this" shows where exactly one permission of the asker's that the viewer may remove covers the action's tool and, after asking ("Stop allowing this?", naming the permission and, for a teammate's, whose), removes it; with two or more it opens Settings > Always allowed; with no actions (the demo) nothing is added
  Covered:  e2e/real/actions-ui.spec.ts, src/screens/approvals/agent-asks.test.ts
  Gaps:     an action's card names its tool account, not the permission behind it, so the row's link to a permission is by account (exact while each tool has one write operation)

Activity: a line's side sheet
  Path:     Activity -> a row
  Selector: dialog named by the line (440px on the right, a bottom sheet on a phone): status ("Needs you" in amber, "Needs a look", "Done", "Checked") and "{day}, {time}", the title, one paragraph, one action ("Review the draft" or "Undo"), toggle "How your agent worked it out", Close
  Expected: the open row is selected; the paragraph joins why, result and who in plain words, with no timings, costs or the word "trace"; Review the draft closes the sheet and opens the review window on that draft, and closing that window gives focus back to the row; Undo takes the change back; the steps toggle lists plain step sentences (at least one line shows them); Escape or Close gives focus back to the row
  Covered:  e2e/page-actions.spec.ts, e2e/no-persona.spec.ts, e2e/ui-round-3.spec.ts, src/screens/activity/plain-steps.test.ts

Tools: list and pages
  Path:     Tools (`#/tools`) -> a tool
  Selector: search, Pause access, Reconnect, Request a tool
  Expected: pausing or disconnecting changes the count, the tool page (Read, Draft, Access) and the composer alike; connected tools with no recorded `lastRead` (`ms <= 0`) read `Connected` on Today and Tools lists and `Not yet` for Last read; Pause access has Undo and Resume brings it all back; Request a tool opens the team window; a catalogue tool's Request (Add a tool) shows "Requested" and a toast starting "Request sent" (the product's once the server has it), stays "Requested" after a reload, and the toast's Undo withdraws it (the product withdraws through route 83)
  Covered:  e2e/data-states.spec.ts, e2e/page-actions.spec.ts, e2e/pages-polish.spec.ts, e2e/pages-polish-phone.spec.ts, e2e/api/connect.spec.ts, e2e/api/tools.spec.ts, e2e/real/tools-return.spec.ts, e2e/real/tools-catalogue-request.spec.ts (a Member's Request on the catalogue's Slack, with the Request buttons counted from `GET /api/tools`' catalogue, not assuming Slack is its only tool: route 81 "Connect Slack", no toast while the request is held at the browser and the toast once the server has it, Requested after a reload, Undo withdraws through route 83), e2e/ship/connectors.spec.ts, e2e/ship/memory-skills.spec.ts (S8), src/state/derive.tool-history.test.ts

Tools: Slack channel
  Path:     Tools -> Slack
  Selector: Slack row
  Expected: its own page with channel details and no tool abilities; before Act it says "included from Act"; Back returns to Tools
  Covered:  e2e/slack-channel.spec.ts

Skills: list
  Path:     Skills (`#/skills`)
  Selector: tabs "Show skills" (All, By Inhouse team, By your team), search, "Create a skill", skill rows, the "Request a skill" link under the list
  Expected: search filters the list; a row opens the skill's page; Create a skill opens a new chat holding `Create a skill that ` (the agent's Skill Creator makes it with the person and saves it with `skill_save`, live for the team at once); a brand skill's row says "Made by <name>" (or "Made by a former member" once the maker's personal data is deleted); Request a skill opens the team window on New job; the product lists the five built-ins (dataviz, PDF, Word, Spreadsheet and Skill Creator), then the brand's own from `GET /api/skills` (read again each time the page opens, and after every run; the Inhouse team reads the list without a grant) with no Off badge
  Covered:  e2e/page-details.spec.ts, e2e/sample-data.spec.ts, e2e/ui-round-3.spec.ts, e2e/api/skills.spec.ts, e2e/api/brand-skills.spec.ts, src/agent/http/skills.test.ts, e2e/ship/memory-skills.spec.ts (S6, S7, S9, S10)

Skills: a skill's page
  Path:     Skills -> a skill (`#/skills/<slug>`, a link the app keeps, one per skill: the Inhouse team's keep the plain slug and a team-made skill with the same name gets "-2"; an unknown slug goes back to Skills once the skills have loaded)
  Selector: link "Skills" (back), the h1 with the icon tile and stage tag, Try in a chat, the try-it strip (`data-skill-try`), "Instructions" (the skill's body as clean text), complementary "About this skill" (Works from, Made by, Who can change it, Used; Tools it reads, Used by); a brand skill its maker or an admin may change: "Edit in a chat", and "Delete skill" in "More for <name>" with the "Delete skill" window; demo only: "More for <name>" (Turn off, Turn on)
  Expected: every one of the 9 sample skills has a full body (When to use, Inputs, Steps, Safety, What you get); Try in a chat starts a new chat holding `Use the "<name>" skill: `; the strip asks its example; turning a skill off shows "Off" and survives a reload; the product reads the instructions from `GET /api/skills/:name` (frontmatter dropped, rendered by the same Streamdown renderer in its page look, with larger type; images stay text there; dataviz shows our own summary; the Inhouse team reads a skill's text only under a live grant) and shows no "Works from" at Watch and no "Used" when there is none; "Made by a former member" shows when the maker's personal data was deleted; "Who can change it" says "<maker> and admins" for a brand skill ("Admins" once the maker's data is deleted) and "Inhouse team" for ours; Edit in a chat opens a new chat holding `Change the "<name>" skill: ` (the demo saves the change and dates it); Delete skill asks in the page's own window (Cancel keeps it and gives focus back to More, which opens the menu again at once), then deletes at the skill's rev, goes back to Skills and says so; a concurrent deletion keeps the skill out of the list, and a refused deletion preserves any other skills refreshed while it was pending; another member (and, after maker deletion, non-admin members) sees neither; ours have no Edit, Delete or Versions
  Covered:  e2e/page-details.spec.ts, e2e/ui-round-3.spec.ts, e2e/api/brand-skills.spec.ts, src/screens/skills.test.ts, src/shell/route-sync.test.ts, src/agent/mock.brand-skills.test.ts, src/agent/http/skills.test.ts, server/brand-skills/store.test.ts, e2e/ship/memory-skills.spec.ts (S9, S10)

Usage
  Path:     account menu -> Usage (it isn't in the sidebar; the palette lists it)
  Selector: month picker, daily bars
  Expected: totals agree in every breakdown; bars are one tab stop with arrow, Home and End; a cap below spend shows the capped state; product loading waits (`Loading usage.`) and failed reads show `LoadError` with Retry; `usageSummary` uses the real month length from `monthKey` and guards empty `daily` arrays and `$0` caps without `$NaN`. In the product a routine's turn (a turn in a chat the Inhouse system owns) counts as a job run: Jobs run counts it (one run per chat, so a run that parks on a question and resumes is still one run, while its spend counts every turn), the Job tab lists one row per routine with its spend and runs, the routine's chat counts as a conversation (Conversations = Questions asked + Jobs run when each person's chat holds one question), and it is not a question and not a row on the Person tab, so Person and Job together add up to the month's spend and Model alone does too; the product has no Tool tab (the demo keeps it)
  Covered:  e2e/app.spec.ts, e2e/page-actions.spec.ts, e2e/edge-cases.spec.ts, e2e/api/usage.spec.ts, server/usage/api.test.ts, src/lib/product-flow.test.ts, src/state/usage-summary.test.ts
  Gaps:     a past month can show "Other routines" in place of a routine's name: routine slots are deleted after the steps retention period while usage turns are kept, so the name can no longer be found; a run whose first turn is in an earlier month also shows there (follow-up filed)

## Settings

Settings: menu
  Path:     Settings (`#/settings/<page>`), the menu beside the app's sidebar (on a phone the menu is the first screen)
  Selector: search "Search settings", groups You (General, Notifications, Memory), Agent (Inhouse agent, Models, Team memory), Approvals and limits (Who approves what, Run limits, Spending cap), Team (Members; Slack notices when Slack is connected), Workspace (Stage and plan, Data and access, Audit log); a lock button "Admins change these" on a team group's heading
  Expected: five groups, each announced by its heading, in this order; the product adds Always allowed under You (Stage 1 M2-H; the demo has no permissions, so it leaves it out, and a link to it lands on General) and leaves out Who approves what, Run limits and Notifications (a link to one lands on General with "That page doesn't exist. You're on General.") and calls the group that is left holding the Spending cap "Spending"; the command palette lists the same pages; Slack notices appears only when Slack is connected (`hasSlack`); search filters pages and rows (a page's matching rows show under it) and "No settings match" shows for none; for someone who can't change brand settings (a Member, test build) every team group's heading has the lock with the tooltip "Admins change these", and an Admin (and the demo) sees none
  Covered:  e2e/sample-data.spec.ts, e2e/navigation.spec.ts, e2e/ui-round-3.spec.ts, e2e/real/settings-lock.spec.ts, e2e/real/product-settings.spec.ts, src/screens/settings/settings-registry.test.ts, src/screens/settings/slack-page.test.ts, src/screens/settings/product-settings.test.ts

Settings: dropdowns and fields
  Path:     Settings -> any page
  Selector: dropdown, text field, search
  Expected: a dropdown opens a real list, works by keyboard, Escape cancels; a pick survives a reload and Reset demo clears it; text fields save and show in the account menu
  Covered:  e2e/sample-data.spec.ts, e2e/menus.spec.ts

Settings: Inhouse agent web tools
  Path:     Settings -> Inhouse agent
  Selector: switches "Search the web" and "Read web pages", field "Websites it may open"
  Expected: the two switches are brand settings (`t:websearch`, `t:webfetch_on`): an Admin or the Inhouse team flips them, a Member reads them as text and the server refuses a Member's write (403); Search the web is off by default, Read web pages on; off means no web request at all (the web egress reads `t:webfetch_on` before every hop, so a session already running and a redirect under way stop too, with zero DNS or page calls, and the model route refuses a web search tool), and a chat or routine turn resolves `webSearch: false` and no fetch host; which websites it may open stays the Inhouse team's (an Admin reads the list as text and can't widen it); an empty host list blocks WebFetch and reads as "No websites" when read-only; a web search value stored while it was a technical setting keeps its value and rev
  Covered:  server/egress/web-switches.test.ts, server/api/resolve-turn.test.ts, server/api/settings.test.ts, server/egress/webfetch.test.ts, runner/test/guards/options.test.ts, src/screens/settings/hosts-field.test.ts, src/screens/settings/web-and-spend.test.ts, e2e/api/web-switches.spec.ts, e2e/real/product-settings.spec.ts
  Gaps:     no container run proves a scripted WebFetch is refused with the switch off (the network-seam unit test does)

Settings: Models
  Path:     Settings -> Models
  Selector: effort picker, on switch
  Expected: Max, Smart (default), Fast, Instant; switching one off hides it; effort persists; one "How hard it thinks" caption sits over the pickers
  Covered:  e2e/models-and-scroll.spec.ts, e2e/pages-polish.spec.ts

Settings: Members and approvers
  Path:     Settings -> Members, Who approves what (the demo only)
  Selector: role control, Remove
  Expected: a one-person team is headed "1 person"; a member is an Admin or a Member, never labelled "Approver", and the Members page says nothing about approval rules (Remove's question and a removed member's toast don't mention them); removing Admin asks first; a removed member stays on the rules that name them with a "Removed" tag (the demo's Who approves what); a wrong cap shows why and isn't saved
  Covered:  e2e/page-details.spec.ts, e2e/edge-cases.spec.ts, e2e/cross-screen.spec.ts

Settings: Slack notices
  Path:     Settings -> Slack notices
  Selector: channel rows "#<name>" with Remove, dropdowns "Add a channel" and "Alerts channel", rows "Before the Act stage", "While Slack is paused", "Who can read them"
  Expected: an Admin or the Inhouse team adds a public channel the connected Slack account is in, removes one (asks first) and picks one alerts channel; shared and non-member channels aren't offered; a Member reads the list and the rules only; while Slack isn't connected or is paused the picker says so with Try again; a stale save shows the latest list. In the product (Stage 1 M2-N, Q3 = A), the agent's post to a listed channel (`notification_send`) follows the same rule as any Slack post: it goes through the outbox as `slack.channel.post`, waits for its person's OK as a card unless a live grant covers that channel (then it posts after the hold), and is refused while the operation is off (every deployable build, N2); a brand Admin marking a channel for alerts gives the brand's grant to post there (the list's API shows it on the alerts channel with its scope and daily limit; moving the mark off takes it back; the Inhouse team's mark, or a mark while the operation is off or Slack isn't connected, gives none), and the server's own fixed notices (an approval is waiting: a new card; a routine failed) post to the alerts channel without a card (a Slack copy with the template's title and a link, never a card's lines; once per card or run slot; nothing without an alerts channel or Slack). The screen doesn't show the grant yet (it's in Settings, Always allowed, for an Admin). The demo keeps the list until a reload
  Covered:  src/screens/settings/slack-page.test.ts, src/agent/http/notifications.test.ts, server/notify-slack/routes.test.ts, server/notify-slack/send.test.ts, server/notify-slack/alerts-notices.test.ts, server/mcp/tools/notifications/send.test.ts, server/outbox/write-safety.property.test.ts (the notice steps), e2e/api/notify-slack.spec.ts

Settings: Stage and plan
  Path:     Settings -> Stage and plan
  Selector: rows "Current stage" and "Next stage", button "Book a check-in"
  Expected: the page names the stage and the next one at Watch, Act and Run; Book a check-in opens the team window on "Change something". The page keeps nothing
  Covered:  e2e/settings-team-pages.spec.ts, e2e/no-persona.spec.ts

Settings: Team memory
  Path:     Settings -> Team memory
  Selector: buttons "Forget", switch "Ask before saving a team rule", button "Teach in a chat"
  Expected: usable at every stage (no stage tag), with a "Waiting for your OK" section for an Admin in the product (Approve, Reject after asking; a stale Approve is refused and says what the rule is now); Forget removes a line with an Undo toast and the Inhouse agent page's count follows; the switch turns off; both survive a reload and Reset demo clears them; Teach in a chat opens a new chat holding "Remember that "
  Covered:  e2e/settings-team-pages.spec.ts, e2e/ship/memory-skills.spec.ts (S2 to S5), e2e/support/memory-scenarios.test.ts
  Gaps:     on a phone a team page is read-only, so S5's phone run turns Ask off through the API and checks the page shows Off; the ship spec doesn't show a routine's team fact waiting while Ask is off (not recorded yet; the store's tests prove it)

Settings: Run limits
  Path:     Settings -> Run limits (the demo only; the product has no such page yet, and the stored `a:<n>` and `l:*` settings and their server checks stay)
  Selector: job switches, "Daily limit", "Largest restock"; button "Pause Inhouse agent" on Settings -> Spending cap (both builds)
  Expected: switches and limits are locked until Run; each works, lists its options and survives a reload; Pause (on the Spending cap page, a section of its own, locked until Act) stops the agent (button, toast and top bar agree: the top bar's status reads "Running" or "Paused", named "Inhouse agent is running" or "... paused" for screen readers; Resume undoes it; the top bar's Pause and Resume button, like the Settings button, shows only for an Admin or the Inhouse team, so a Member sees the status text with no button) and survives a reload; Reset demo clears all of it
  Covered:  e2e/settings-team-pages.spec.ts, e2e/settings-agent-data.spec.ts, e2e/ship/setup-gaps.spec.ts, e2e/real/product-settings.spec.ts

Settings: Notifications
  Path:     Settings -> Notifications (the demo only: every row is Act-stage work nothing sends yet, so the product leaves the page out)
  Selector: dropdowns "Approvals waiting" and "Send alerts to", switches "Slack" and "Weekly report"
  Expected: locked at Watch; each dropdown lists its choices and saves a pick, the switches turn off; a reload keeps all of it and Reset demo clears it; the dropdown works by keyboard; with no channel connected alerts default to Email and there is no channel switch; on a phone the controls stay
  Covered:  e2e/settings-your-pages.spec.ts, e2e/sample-data.spec.ts, e2e/brand-data.spec.ts, e2e/settings-pages-phone.spec.ts

Settings: Always allowed (Stage 1 M2-H, the product)
  Path:     test build -> Settings -> Always allowed (`#/settings/you-permissions`)
  Selector: section "Done without asking", rows `[data-permission]` (title; "{tool} · {scope} · Up to N a day", and "For {name}" on a teammate's), button "Remove: {title}", the question "Stop allowing this?"
  Expected: a member sees their own permissions, an admin everyone's; Remove shows only where the permission's `can.remove` says so, asks first, sends the rev it read and shows the list after it with a toast; a stale Remove says "This permission changed first. Here it is now." and reads the list again; none: "Nothing yet. When you choose Always allow on an action, it shows here."; usable on a phone (a You page, not read-only); the Inhouse team has no Always allowed (not in its menu or the command palette, and the page reads nothing)
  Covered:  e2e/real/actions-ui.spec.ts, src/screens/approvals/agent-asks.test.ts, src/screens/settings/product-settings.test.ts

Settings: Memory
  Path:     Settings -> Memory
  Selector: buttons "Forget", switch "Learn from my chats"
  Expected: usable at every stage (no stage tag); Forget removes a line with an Undo toast; the switch turns off (and in the product the agent then refuses to save your preferences, and says why); both survive a reload and Reset demo clears them; Team memory is not touched; Forget works on a phone
  Covered:  e2e/settings-your-pages.spec.ts, e2e/settings-pages-phone.spec.ts, e2e/ship/memory-skills.spec.ts (S1), e2e/support/memory-scenarios.test.ts

Settings: Inhouse agent
  Path:     Settings -> Inhouse agent
  Selector: text field "Brand name", demo only: dropdown "Tone" and text field "Signs emails as"; buttons "Open memory" and "View skills"
  Expected: the brand name is the brand's `b:name` setting (an Admin edits it; the product's sidebar subtitle, the delete request on Data and access and Library previews read it; the test seed sets it, a new brand starts empty); the tone and sign-off (demo only: nothing reads them in the product) save, survive a reload and Reset demo clears them; Open memory opens Team memory, View skills opens Skills; the memory count follows Team memory; on a phone the values read as text and the buttons work
  Covered:  e2e/settings-agent-data.spec.ts, e2e/settings-team-pages.spec.ts, e2e/page-details.spec.ts, e2e/settings-pages-phone.spec.ts, e2e/real/product-settings.spec.ts, src/agent/http/client.test.ts

Settings: Spending cap
  Path:     Settings -> Spending cap
  Selector: fields "Monthly cap" and "Job budget", dropdowns "Alert at" and "Show amounts in", button "Pause Inhouse agent"
  Expected: the Job budget (`s:job_cap`, the most one long job may spend, $25 by default) takes $0.25 to $100: the field says "Enter an amount from $0.25 to $100." and doesn't save outside it, and the server refuses it too (400); only an Admin or the Inhouse team changes either amount (a Member reads both as text, and the server refuses a Member's write); Pause Inhouse agent (locked until Act, then as in Run limits) sits here in both builds, so the product can pause at Act and Run; only an Admin or the Inhouse team gets the button (a Member can't pause: the server refuses it); a cap and alert level show on Usage; a wrong amount says why and isn't saved; a cap below spend shows the cap banner and the capped state; the currency pick saves; values survive a reload; on a phone it reads as text
  Covered:  e2e/cross-screen.spec.ts, e2e/edge-cases.spec.ts, e2e/data-states.spec.ts, e2e/page-details.spec.ts, e2e/sample-data.spec.ts, e2e/pages-polish-phone.spec.ts, e2e/phone.spec.ts, src/screens/settings/web-and-spend.test.ts, e2e/api/web-switches.spec.ts, e2e/real/product-settings.spec.ts

Settings: Data and access
  Path:     Settings -> Data and access
  Selector: dropdowns "Chats" and "Activity and steps", row "Next cleanup", switches "Inhouse team access" and (demo only) "Two-step sign-in", buttons "Export" and "Ask the team"
  Expected: Your team shows "1 member" for a one-person team; retention picks and the switches save, survive a reload and Reset demo clears them; in product, Chats and Activity and steps set the age rules for nightly retention, and the overdue health signal gives an edited period 26 hours for the job to catch up; Until deleted turns off the corresponding age rule while the trash period still applies; the audit log's retention is fixed; only the Inhouse team changes the two periods (route 12): an Admin and a Member read them as text with "The Inhouse team sets this."; Next cleanup shows the nightly cleanup's next run (03:30 UTC, in the brand's time) to everyone; Export (P8a D) is offered to an Admin and the Inhouse team under a live grant, never a Member: in product it first checks the export would start (route 96, nothing written), then downloads the brand's export for the caller as one NDJSON file (route 95, streamed; a header naming every registry store and whether the caller gets all, part or none of it, a line per row or file, an end line with counts) with a toast that it can take a few minutes, and the audit log gets one "downloaded all brand data" line with counts only; the export holds the brand's shared data and the caller's own, never another person's personal memories, personal settings, photo or chats, and members as the Members page shows them (no sign-in subject, no Inhouse team or service row); the Inhouse team gets no chats and no requester ids (ops/export/brand-for-caller.ts); the export includes shared connector status and listed Slack channels without attribution and excludes credentials and delivery history; a brand too big for one request, a grant that ended or storage down shows a plain toast in the app, no download and no audit line; in the demo it downloads a small invented sample in the same shape with a toast saying so; Ask the team opens the team window on "Change something" with the delete request written ("... for <brand name>.", or without the name while none is set); on a phone it reads as text and Export still downloads
  Covered:  e2e/settings-agent-data.spec.ts, e2e/settings-pages-phone.spec.ts, e2e/no-persona.spec.ts, e2e/api/data-access.spec.ts, e2e/api/matrix.spec.ts, e2e/real/data-export-download.spec.ts (an Admin clicks Export on the test build: a browser download of the NDJSON file with the caller's header, counts and end line, the toast (asserted right after the download event, inside its 6 s life), and the audit line), server/api/data-access.test.ts, src/screens/settings/data-access.test.ts, ops/export/brand-for-caller.test.ts, ops/export/export.test.ts
  Gaps:     a refused export (route 96's 409, 403 or 503) isn't clicked in a browser (P8a's S1 and S4 in e2e/ship/production-readiness.spec.ts are the orchestrator's); a brand past one request's budget (900 D1 queries, about 200,000 rows, and 9,000 R2 calls, ops/export/export.ts `REQUEST_BUDGET`) is refused rather than exported, and needs the Inhouse team's export; other members' chat outputs that show in the Library aren't in the caller's export

Settings: Audit log
  Path:     Settings -> Audit log
  Selector: rows, button "Download CSV"
  Expected: the seeded rows show; pausing the agent adds a row at the top that survives a reload and Resume takes away; Download CSV saves the log with plain spaces in its times; First day and Loading show their own empty line
  Covered:  e2e/settings-agent-data.spec.ts, e2e/sample-data.spec.ts, e2e/pages-polish.spec.ts, e2e/settings-pages-phone.spec.ts

Settings: General
  Path:     Settings -> General
  Selector: text field "Name", dropdowns "Theme", "Time zone" and (demo only) "Language" and "Text size", photo upload
  Expected: the name saves, shows in the account menu and Reset demo clears it; the Role row reads the job title and role ("Head of Ops · Admin"), or the role alone when there is no title; a time zone pick saves, survives a reload and Reset demo clears it, on a phone too; Theme as in "Palette: theme switch" below; every dropdown opens a real list (Language and Text size, demo only: nothing reads them in the product, partial, see Gaps); the photo as in "Settings: photos"
  Covered:  e2e/sample-data.spec.ts, e2e/cross-screen.spec.ts, e2e/phone.spec.ts, e2e/menus.spec.ts, e2e/photo.spec.ts

Settings: photos
  Path:     Settings -> General -> photo
  Selector: upload, Remove
  Expected: the photo shows in the sidebar, account menu, Members, Activity and Usage; bad files give an error toast; reset clears it
  Covered:  e2e/photo.spec.ts

## Shell and states

Product build: startup and initial loading screen
  Path:     `npm run build:product`, any URL (`?demo` and `?demo=<anything>` included)
  Selector: neutral loading status (`Loading…`) while the initial account read runs; alert "Couldn't load Inhouse." and button "Retry" on failure, the product project (`E2E_PRODUCT=1`)
  Expected: one neutral loading screen in place of every page during the initial account read. With Access unconfigured, the read returns 503 and the load error with Retry replaces the requested page. The screen has no sample names, demo switches or Reset demo. The build ignores `?demo` (`scripts/check-product-build.mjs` checks for the absence of the demo clock).
  Covered:  e2e/product/no-demo.spec.ts, e2e/real/start-errors.spec.ts (the held first read shows the loading screen, then the app; no failure or retry screen shows it)

Test build: the product Worker's API and app (P2)
  Path:     `npm run build:product-test`, then `/api/*` with no Access JWT, and `/` in a browser
  Selector: the `api` project (status and body), the `real-desktop` and `real-phone` projects (heading "Your sign-in ended", wrong-account heading and load-error alert)
  Expected: every `/api/*` path (an unknown one too) answers 401 `{"error":{"code":"unauthorized"}}` with the security headers and `no-store`; the app loads under the enforced CSP. The first account read shows "Your sign-in ended" on 401 and "This is an Inhouse team account" on 403 wrong_kind. On 503, "Couldn't load Inhouse." stays visible during Retry. A successful retry opens the requested page without a reload.
  Covered:  e2e/api/skeleton.spec.ts, e2e/real/skeleton.spec.ts, e2e/real/start-errors.spec.ts

Backend core: account menu, name and role (P2, test build)
  Path:     sign in as a seeded person -> sidebar -> account and settings
  Selector: menu "Account" (the name with the role as a badge beside it, the email on its own line), items Your settings, Team settings, Sign out
  Expected: the menu shows the signed-in person's own name, email and role (Admin, Member or Inhouse team); Sign out navigates to the Access logout path
  Covered:  e2e/ship/backend-core.spec.ts (S1, S5, S7, S8), e2e/real/sign-out.spec.ts (local test-build navigation)

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
  Gaps:     the brand setting `s:job_cap` is accepted by the Worker but has no Settings field yet; chat job continuation is not wired yet

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

Backend core: "This is an Inhouse team account" (P8a, test build)
  Path:     sign in on the brand app with an identity bound to the Inhouse team (the Worker answers 403 wrong_kind) -> any URL
  Selector: heading "This is an Inhouse team account", button "Sign out"
  Expected: one final screen in place of every page, telling them to sign out and sign in with their brand account; no "Sign in again", no reload and no second read (it was a 401 and "Your sign-in ended", which looped); Sign out goes to Access's logout; the API answer is the code and reason only (no member id, name or email)
  Covered:  e2e/real/start-errors.spec.ts, e2e/api/auth.spec.ts, src/agent/http/client.test.ts

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
  Expected: pages, settings pages and chats open; Escape returns focus; shortcuts skip fields except Cmd+K; the palette loads the first time it opens or once the browser is idle (not with Today's first load); Cmd+K before it has loaded opens it as soon as its chunk is in
  Covered:  e2e/navigation.spec.ts, build-support/entry-graph.test.ts (the palette, cmdk and the base Code Block stay out of the entry)

Palette: theme switch
  Path:     Cmd+K -> Switch to dark theme (or light); Settings -> General -> Theme
  Selector: palette item, Theme dropdown, root `dark` class, body colour
  Expected: the palette item flips light and dark, and Settings adds System (follows the OS setting live); each sets the class and the page colour, is saved in `inhouse.theme` (System saves nothing) and survives a reload
  Covered:  e2e/palette-theme.spec.ts

Palette: Report a bug
  Path:     Cmd+K -> Report a bug
  Selector: option "Report a bug", team window Send
  Expected: the window opens on the bug type; Send waits for words; sending closes the window, shows "Bug sent to your Inhouse team. Thank you." and lists the report among the open requests (the palette and a crash's Message the team are the ways in on that type; the account menu has one team entry)
  Covered:  e2e/report-bug.spec.ts

Sidebar
  Path:     sidebar -> collapse
  Selector: Search row (`⌘K` / `Ctrl+K`) above nav "Main": Today, Approvals (count), Activity, Library, then group "Your agent" (Routines, Skills, Tools); Recent chats; the bottom row: the account row, button "Your Inhouse team" (`support_agent`) and button "Sidebar" (tooltip "Collapse sidebar" or "Expand sidebar" with `⌘\`); rail tooltips
  Expected: Search opens the command palette from the expanded sidebar (and rail/phone drawer), keeping the top bar uncluttered; two nav sections, the second labelled and announced as a group; no team card, no Tools/Skills/Usage list at the bottom; the Inhouse team button and the collapse button sit in the sidebar's bottom row beside the account row (the collapse button desktop only; the top bar has none), and on the rail above the avatar; the team button opens the team window (on a phone the drawer closes first); the rail shows group 1, a divider, group 2 and the avatar; the account row is selected on Settings and Usage; a skill's page keeps Skills selected; collapses to a rail with focus kept on the button, stays collapsed after a reload, expands with the shortcut; on desktop windows center in the room right of the sidebar; Approvals' count adds (Stage 1 M2-H, the product) the action cards that wait on this person (an answer or a resolve their card's `can` allows, never an admin's view of a member's card) and their open questions, read at start, on focus, on `action.updated` and after each answer, and shown even while the stage locks the row (`src/shell/asks-count.ts`)
  Covered:  e2e/navigation.spec.ts, e2e/models-and-scroll.spec.ts, e2e/help-account-menu.spec.ts, e2e/library.spec.ts, e2e/ui-round-3.spec.ts, src/shell/asks-count.test.ts and e2e/real/actions-ui.spec.ts (the M2-H count)

Account menu
  Path:     sidebar -> account and settings
  Selector: menu "Account" (name with the role badge, the email under it), items Your settings, Team settings, Usage | Your Inhouse team ("N open"), Help and guides (demo only) | Sign out
  Expected: the role (Admin, Member or Inhouse team) is a badge beside the name, the email on its own line, both cut with an ellipsis when long; Your settings opens General and Team settings Stage and plan (on a phone the settings menu first); Usage opens the Usage page; Your Inhouse team opens the team window and its count equals the open rows under Your requests (shown only above 0); Report a bug and Feedback are request types in that window; Help and guides is hidden in the product build; Sign out says it isn't connected in the demo
  Covered:  e2e/help-account-menu.spec.ts, e2e/report-bug.spec.ts, e2e/tour.spec.ts, e2e/sample-data.spec.ts, e2e/phone.spec.ts, e2e/overlays-keyboard.spec.ts, src/lib/product-flow.test.ts, e2e/real/product-hides.spec.ts (no Help and guides in the product's account menu)

Help and guides
  Path:     account menu -> Help and guides (demo only)
  Selector: dialog "Help and guides", guide buttons, button "Ask the team"
  Expected: one guide open at a time and its text shows; Ask the team swaps Help for the team window on Feedback with "I have a question: " written, and the sent question is listed and survives a reload; by keyboard it opens quiet and Escape gives focus back; on a phone it fits 390; hidden from the account menu in the product build (`src/lib/product-flow.ts`)
  Covered:  e2e/help-account-menu.spec.ts, e2e/sample-data.spec.ts, e2e/overlays-keyboard.spec.ts, e2e/cross-screen.spec.ts, e2e/no-persona.spec.ts, e2e/settings-pages-phone.spec.ts, src/lib/product-flow.test.ts, e2e/real/product-hides.spec.ts

Problem panel
  Path:     Today or Approvals -> a card, or an Activity line's Review the draft
  Selector: the review window (960px wide and short, centered in the room right of the sidebar), top line with the "Urgent" pill and the area (as on the cards), "Ask Inhouse" (the Watch main button and the More menu item), "{n} of {N}" with Previous and Next, the draft document with Edit, sources toggle "Checked ...", the main action and "More" (Don't send, Ask <approver> in the demo only, Ask Inhouse, Snooze until tomorrow, Not a problem; hidden when it would be empty)
  Expected: Previous and Next step through the cards that need you in the order the page shows them, and Approve moves straight to the next once it's approved (a refused Approve stays on the draft and says why above the buttons); a problem with no real draft (the product's morning-check placeholder) shows the Watch view (suggestion, Ask Inhouse) at any stage; Escape on More closes the menu only; a window too narrow for two columns (a narrow desktop with the sidebar open) stacks the brief over the draft; the approval actions as in Approvals above; the footer (waiting only) holds only the buttons, left-aligned: the main action with the amount it moves and More; who usually approves, when it's someone else, is a quiet note (person icon) under the draft sheet, never in the footer; Ask <approver> says it isn't connected; Ask Inhouse (in the window and the card menu) starts a chat holding the question that a reload keeps; no risk tag, memory line, step timings or costs show; a purchase order shows its item table and total
  Covered:  e2e/problem-panel.spec.ts, e2e/today-approvals.spec.ts, e2e/app.spec.ts, e2e/page-actions.spec.ts, e2e/sample-data.spec.ts, e2e/phone.spec.ts, e2e/ship/needs-you-cards.spec.ts, e2e/ui-round-3.spec.ts, src/state/derive.no-draft.test.ts

Trace window
  Path:     an answer's steps line, or an Activity row
  Selector: dialog "What your Inhouse agent did", radio "Technical", button "Replay", `trace-row` (`aria-expanded`)
  Expected: nested `Trace` rows from `mapTraceToTraceRows`; the plain view shows the question, time, and expanded `plainIo` prose only (never mounts `CodeBlock`, raw `detail`, `io`, model ids, or token words); Technical shows tokens, a slim duration bar per row aligned to ticks/playhead (D2), and expands each row into a `CodeBlock size="sm"` with `detail`, kind, duration, `io.input`, and `cut`/`denied` badges; Replay maps `t` to pending, running, or done and updates stats and playhead; an answer sent mid-run opens its own steps
  Covered:  e2e/app.spec.ts, e2e/conversation-polish.spec.ts, e2e/no-persona.spec.ts, e2e/overlays-keyboard.spec.ts, e2e/trace-replay.spec.ts (on the page clock: Replay from the start, Pause replay holds, the speed steps 1×, 2×, 5×, the replay ends on the full result, Restart, Stop and show everything)

Notifications and team window
  Path:     bell -> a line; account menu -> Your Inhouse team
  Selector: bell count, window Send
  Expected: reading a line drops the count, Mark all as read empties it; Send waits for words and carries the name from Settings
  Covered:  e2e/navigation.spec.ts

Team window
  Path:     sidebar button "Your Inhouse team" or account menu -> Your Inhouse team (also Report a bug, Help's Ask the team, Request a tool, Book a check-in)
  Selector: dialog "Your Inhouse team" (the `form` window size: 720px, capped to the room right of the sidebar), radiogroup "Team window" (New request, "Your requests {N}"); New request: radio kind tiles (five, compact, the picked one with a 1px dark border), "Title", "Details" (at most 934, so the title and details fit the server's 1000 together; a counter for the last 100), "Send to the team"; Your requests: radiogroup "Show requests" ("Open · N", "Closed · N"), list "Open requests" or "Closed requests", each row a toggle with kind icon, title, "{kind} · {who}, {when}" and a status chip, "Withdraw request" in an open row you asked (demo and product)
  Expected: Send waits for a title or details (a title is made from the details when none is typed), closes the window and lists the request as open once the agent took it; a refused request keeps the window open with what was typed and says "Your request wasn't sent." with the reason; statuses are only With the team, Done, Declined and Withdrawn; a status never carries a date; a row opens to show its full text; Withdraw moves it to Closed as Withdrawn and the account menu's count follows (the demo's toast has an Undo; the product withdraws through route 83 with no way back, so its toast has none, and the withdrawn request stays in Closed across refreshes); a withdraw that fails keeps the row open and says "Your request wasn't withdrawn." with the reason under it (one the team answered meanwhile moves to Closed as the team left it); the demo's toast promises a reply within one working day, the product's doesn't; on the product a request goes to route 81 as one text (the title on its own line above the details), Your requests refreshes all open requests and the 50 most recently closed on each open (a failed read shows "Couldn't read your requests." with Retry), a teammate's request shows their name, and a bug has no screenshot box
  Covered:  e2e/help-account-menu.spec.ts, e2e/report-bug.spec.ts, e2e/navigation.spec.ts, e2e/sample-data.spec.ts, e2e/ui-round-3.spec.ts, e2e/real/team-request.spec.ts, src/state/derive.team-requests.test.ts, src/agent/http/team-requests.test.ts, src/lib/product-flow.test.ts, e2e/real/team-request-refused.spec.ts, e2e/api/team-requests.spec.ts, e2e/ship/memory-skills.spec.ts (S7)

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
