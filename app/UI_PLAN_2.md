# UI plan 2: design audit

Tracks the seven PRs that came out of the design audit on 2026-11-17 (every screen, light and dark, desktop and a 390px phone, plus the code). Finding ids below (H1, M7, L3) come from that audit. Update this file in every PR of the plan: tick what landed, add the PR link, note anything moved or dropped and why.

**Status: approved on 2026-11-17.** The plan, the seven PRs and all nine decisions are approved as recommended. D2 was approved after mockups: one white card per answer, the person's message a soft grey bubble.

Every PR stays on the UI system in [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) (ui-base's guide) and [`DESIGN_APP.md`](DESIGN_APP.md) (Inhouse's layer): tokens only, a new value becomes an `--app-*` token in the app's override block (both themes), Radix components for menus, dialogs, popovers, sheets, tooltips and accordions, a distinct part is an app component in `src/ui` with `cva` variants, no literals. Each PR passes `npm run lint` (with `lint:tokens`), `npm run typecheck`, the a11y suite and the visual suite, updates baselines on purpose after every changed screenshot has been checked (both themes, desktop and phone), gets a screenshot check in the running app, and adds one medium-hard E2E scenario.

## Sequence

```
PR 1 ─┬─► PR 2 ─┬─► PR 4 (Today, Approvals, review panel)
      │         ├─► PR 5 (Conversation and composer)
      └─► PR 3 ─┼─► PR 6 (Library)
                └─► PR 7 (Pages and windows)
```

- PR 1 rewrites the token file and `components/ui`, so it goes alone.
- PR 2 (the look: `src/ui`, tokens, shared parts) and PR 3 (the logic: `src/state`, `src/agent`, sample data, toasts) run side by side. They share no source file. PR 2 merges first: PR 3 then takes `main` and does its edits in screen files (the sidebar's running dot, delete-answer Undo, stub wording) in a last phase.
- PR 4 to 7 start once PR 2 and PR 3 are merged. Each owns its own screen files.
- Shared by every PR, and only ever appended to: the app's `--app-*` block in `src/index.css`, this tracker, and the baseline PNGs. The second PR to merge takes `main` and regenerates its changed shots.

## Status

| PR | Scope | Branch | Status |
|---|---|---|---|
| 1 | Onto ui-base | `refactor/onto-ui-base` | Merged |
| 2 | One system, both themes | `refactor/one-system` | Merged |
| 3 | State, Undo and believable data | `fix/state-undo-data` | Merged |
| 4 | Today, Approvals and the review panel | `feat/today-approvals-polish` | In review |
| 5 | Conversation and composer | `feat/conversation-polish` | Proposed |
| 6 | Library | `feat/library-polish` | Proposed |
| 7 | Pages and windows | `feat/pages-polish` | Proposed |

## Decisions

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| D1 | Inhouse's extra `Button`, `Badge`, `Input` and `Sheet` variants: upstream to ui-base (a PR and a new tag) or keep in `src/ui` wrappers | Upstream what any app needs (`xs`, `icon-round`, `aria-pressed`, Badge `size`, Input `sm`, Sheet `overlayProps`). Keep `chrome`, `surface`, `inverse`, `quiet` in the wrapper | PR 1 |
| D2 | How an agent's answer looks: keep one white bubble per part, or one white card per answer (text, table and drafts inside it, the person's message a soft grey bubble). Text never sits straight on the dots | One white card per answer. It changes the v4 look, so it's a design call | PR 5 |
| D3 | Phone: keep six icons under every answer (shipped in PR 4 of the first plan), or Copy and steps plus "···" | Copy, steps and "···" | PR 5 |
| D4 | Phone: can admins change team settings (effort pickers, exports) from a phone | Pages stay readable, controls move to desktop | PR 7 |
| D5 | Locale and clock for the demo: US or UK formats, and the date (17 Nov 2026 is a Tuesday, the app says Monday) | US formats, 12-hour time, one fixed demo clock, fix the weekday | PR 3 |
| D6 | Slack in the demo: a connected tool, or not connected with every Slack mention removed | Connected (Act and Run rely on it) | PR 3 |
| D7 | Phase 1 memory: keep drafts, started chats, the model pick and the Library view across a reload (local storage) or leave to phase 2 | Keep them. Copy link on a new chat is broken without it | PR 3 |
| D8 | What the agent says to an off-script question in the demo | "I can't answer that from your tools yet", name the six tools, offer the suggested questions as chips. Never "sample data" | PR 3 |
| D9 | Leaving a chat mid-answer: the answer finishes in the background (the sidebar already has a running dot), or it stops with a note and Retry | Finish in the background | PR 3 |

## PR 1: Onto ui-base

No visual change. The visual suite must pass with zero baseline updates.

- [x] Split `src/index.css` into the base-owned `ui-base.css` and the app's override block (H9)
- [x] Icon seam moves to `src/components/ui/icon.tsx` with `icon-names.ts`; every `@/ui/icon` import follows
- [x] `scripts/check-tokens.mjs` from ui-base, `check-tokens.allow.json` in the base format
- [x] `src/components/ui/*` and `src/lib/utils.ts` back to the base; app-only variants per D1
- [x] `--pad-x` becomes `--app-pad-x`
- [x] `DESIGN_SYSTEM.md` points to ui-base instead of "copy these folders"; `AGENTS.md` lists this tracker
- [x] Inhouse's own rules move to the new `DESIGN_APP.md`, since the base now owns `DESIGN_SYSTEM.md`
- [x] Inhouse's two extra lint rules (arbitrary values, literal inline styles) live on in `scripts/check-app-rules.mjs`, run by `npm run lint:tokens`

Files: `src/index.css`, `src/ui-base.css` (new), `src/components/ui/*`, `src/lib/utils.ts`, `src/ui/icon.tsx`, `src/ui/index.tsx` (the Button wrapper), `scripts/check-tokens.*`, `scripts/check-app-rules.*` (new), `package.json`, `DESIGN_APP.md` (new), import lines across `src`.
Risk: high reach, low intent. Any pixel that moves is a bug.
Verify: visual suite with `--update-snapshots=none` and no failures, a11y, the full E2E suite, `lint:tokens` on the base script. A ui-base PR and tag if D1 says upstream.

Notes from the build:
- **ui-base v1.1.0** took D1's upstream half: Button `xs`, `icon-round` and the pressed `outline`, Badge `size` plus `warning`, `brand`, `muted` and `status`, Input `sm`, Sheet `overlayProps`, and the tailwind-merge seam. Pulled with `npx shadcn@4.23.0 add ui-base/update#v1.1.0 -y --overwrite`.
- **What moved where.** The base tokens now live in `src/ui-base.css` (base-owned); `src/index.css` keeps the fonts, the override block (only `--font-sans` and `--font-mono`, since Inhouse self-hosts Geist), the `--app-*` tokens and the app helpers. `src/ui/icon.tsx` became `src/components/ui/icon.tsx` (Material Symbols, mapping the base's `icon-names.ts`). The app's tailwind-merge names moved from `src/lib/utils.ts` to `src/lib/merge-config.ts`. Inhouse's part of the old `DESIGN_SYSTEM.md` is now `DESIGN_APP.md`; `DESIGN_SYSTEM.md` is the base's guide.
- **Decisions:** Q1, the app's merge names go in the app-owned `src/lib/merge-config.ts`. Q2, Badge is the base's, no wrapper. Q3, only a disabled primary button dims: the `src/ui` Button, IconButton and Select add `disabled:opacity-100`. Q4, the base `check-tokens.mjs` plus the app-owned `scripts/check-app-rules.mjs` (arbitrary values, literal inline styles), both in `lint:tokens`. Q5, the base owns `DESIGN_SYSTEM.md`, Inhouse's layer is `DESIGN_APP.md`. Q6, the ui-base release is tagged `v1.1.0` (additive, with one CHANGELOG step for apps on v1.0.0). Q7, `lucide-react` and the `@fontsource-variable` packages the update adds are removed again (nothing imports them).
- **For PR 2 to 7:** a new app value is an `--app-*` token in `src/index.css` (the app `:root` block and its `@theme inline` mapping) and its class name in `src/lib/merge-config.ts`, or `cn()` drops it. A new app-only Button look goes in `APP_BTN` in `src/ui/index.tsx` (an IconButton one next to `CHROME`), never in `src/components/ui/`. Never edit `src/ui-base.css`, `src/components/ui/*` (except `icon.tsx`), `src/lib/utils.ts` or `scripts/check-tokens.mjs`: the next update rewrites them, and a change every app needs goes to ui-base as a release. The page padding token is `--app-pad-x`. Content art: colors in `scripts/check-tokens.allow.json`, sizes and inline styles in `scripts/check-app-rules.allow.json` (with a reason).
- **Every update rewrites `DESIGN_SYSTEM.md`** and re-adds `lucide-react` and the two `@fontsource-variable` packages to `package.json`; remove them again until ui-base stops shipping them to apps that don't use them.

## PR 2: One system, both themes

- [x] One content edge: list pages share one column width, Today and Usage keep wide (M29)
- [x] Size variants replace raw px props: `Window`, `SearchBox` (one look), `LogoTile`, `IconTile xl`, a menu-item height step, the answer-action button size; z-layer tokens; no `!` outside `motion.ts` (M37)
- [x] Shared parts: `NavItem` variants for the Settings and Library side menus (one selected look), one `SelectionBar`, one `Confirm`, `SectionHeader` with one indent, `PageHeader` on the tool page (M30, M38)
- [x] Radix Accordion for Help, `Tooltip` instead of every native `title=` (M38, M31)
- [x] Dark, by tokens only: off switch, destructive button text, a visible step and shadow for menus, pop-ups and dialogs, the scrim, a muted text token for handled cards in place of opacity (M20, M21)
- [x] Windows and sheets open without a focus ring and tooltip on Close; rail tooltip and hover fill (L6, L7)
- [x] Dead code out, specs renamed by feature, stale docs fixed (L16, L17). Moved to PR 3: the persona identifier rename (it runs through `src/agent` and `src/state`) and the README's stale lines (`README.md` is PR 3's file)
- [x] Skip link and a banner landmark for the top bar (L18). Moved to PR 3: both need `App.tsx` and `TopBar.tsx`, which PR 3 owns. Done in PR 3

Files: `src/index.css` (app block), `src/ui/*`, `src/overlays/HelpWindow.tsx`, `src/shell/Sidebar.tsx`, `src/shell/DevSwitcher.tsx`, class-level edits in `src/screens/*` and `src/overlays/TeamWindow.tsx`, spec renames in `e2e/`, the three docs.
Risk: medium. Many small visible changes on every screen.
Verify: every changed baseline reviewed and visually checked, a11y in both themes, E2E: tab from the skip link through a page, open and close each overlay by keyboard with focus back on its trigger, in dark.

Notes from the build:
- **Verified.** New spec `e2e/overlays-keyboard.spec.ts` (every overlay by keyboard in dark, focus back on its trigger, windows open quiet, a locked switch's reason by keyboard; the skip link part moved to PR 3 with L18). Every changed shot (light and dark, desktop and phone) was visually checked and the code reviewed before the baselines were updated. Eight states joined the visual and a11y suites: Today in Run, Today after approving all, Models, a routine delete confirm, both selection bars, an open Help guide and the Library's file viewer.
- **One list column.** Approvals, Activity and All chats moved from 800 to the 900 `page-default` column. `Page` has no `narrow` variant any more; `--app-page-narrow` stays for a Settings page's column and the top bar. All chats needs `w-full` on its `Page` (its screen is a flex column, so the column shrinks to its content without it).
- **Parts added in `src/ui`:** `MenuItem` (a menu row; a locked one keeps its menu open and doesn't fire), `SelectionBar` (`over` centres it on the content it acts on, clamped 12px inside the window, `data-bottom-dock` for PR 3's toast stack), `Guide` (Help's accordion look; `components/ui/accordion.tsx` stays stock), `LogoCount` (the "+N" chip, on `LogoTile`'s sizes), `RailTip`. Changed: `Window` (`size`, `layer`), `SearchBox` (one bordered field), `LogoTile` and `IconTile` sizes, `IconButton` `action` and `filled`, `Switch` `reason` (a locked switch stays focusable, says why in a tooltip that also opens on tap, and carries the reason as its description), `NavItem` sizes `fit` and `tap` with `meta` and `detail`, `PageHeader` `leading` and `tag`, `StageTag strong`, `Segmented` (muted text on the picked segment), `TAP_Y` (a phone tap area as wide as the button).
- **Tokens added:** window sizes and tops (`w-window-sm/md/lg/xl`, `top-window*`, `max-h-window-max`, `max-h-window-max-lg`), the z layers (`z-raised`, `sidebar`, `composer`, `window`, `bar`, `trace`, `confirm`, `toast`, `dev`), `text-done` and `bg-done`, `bg-destructive-solid`, `text-on-destructive`, `bg-switch-off`, `bg-window-surface`, and scoped values for pop-ups (`--app-popup-fill`, `-fill-hover`, `-divider`, `--app-menu-cursor`, `--app-menu-muted`) and windows (`--app-window-hover`, `--app-window-well`), `--app-picked-muted`, `--app-tag-edge-strong`, `--app-hatch-approval-stripe`. The dark values and their contrast are in `DESIGN_APP.md`.
- **A token name must not sit in two Tailwind namespaces one utility reads.** `w-*` looks up `--spacing-*` before `--container-*`, so a max-height token named `--spacing-window-lg` made the file viewer 90vh wide. The max-heights are `window-max` now. Check a new name against both blocks of `@theme inline`.
- **Dark roles:** hover is `--accent` (#303030), selected is `--fill-hover` and `--fill-picked` (#383838), an open menu trigger keeps its hover look. Menus and pop-ups are #242424 with an edge and a shadow; every window, sheet and dialog is `bg-window-surface` (#1f1f1f; #f7f7f7 in light).
- **The toast and the demo switches only order inside the app root** (`z-toast`, `z-dev`): windows portal to `body`, so a window's scrim covers a toast until PR 3 portals the toast stack.
- **Specs.** Specs are named by feature (`edge-cases`, `text-fit-phone`, `dots-and-today*`, `cross-screen`, `page-details*`, `models-and-scroll*`). States reached by a click wait for animations to end (`atRest` in `e2e/states.ts`), and a state with a time in it fixes the clock. Radix moves menu focus in a timer after each arrow key, so a spec waits for focus between two arrow presses.
- **ui-base release candidates:** the dark `--popover`, `--accent`, `--fill-hover`, `--scrim` and elevation values, a `--destructive-foreground` token, an off-switch track token and a `Switch` that doesn't dim when disabled and can carry a locked reason, the z-layer tokens with their merge group, the Accordion.
- **Leftovers for PR 3's files:** `TopBar.tsx` `z-1` to `z-raised` and the toast's `z-60` to `z-toast`; the account menu's rows in `Menus.tsx` as `MenuItem`; the open bell's fill (`aria-expanded:bg-accent`) if wanted; the file `src/ui/useDialogFocus.ts` no longer holds a hook (renaming it touches `state/store.ts`).
- **Found, left for the PR that owns the screen:** PR 4, "Restocked 11 / units" wraps in Today's handled banner, and the Approvals "usually approves" note now sits at the end of the button row. PR 5, All chats' time column ends 62px inside the card and jumps 36px when Select is toggled; the Trace's hand-built replay and speed buttons. PR 6, the Library's phone place pills keep their own selected look, and the viewer cuts a long file name on a phone with the full name shown nowhere. PR 7, the model switches have no visible label, and the Skills and Routines sheets use a plain `animate-none`. The phone baselines on `main` had drifted 2px on the top bar's menu icon before this PR; the new baselines reset that.

## PR 3: State, Undo and believable data

- [x] Toasts as a stack in their own component: each keeps its Undo and timer, pauses on hover and focus, has a close button, sits above the composer and the safe area, and a notice never replaces an Undo (H3, M3, M4)
- [x] Leaving a chat mid-answer per D9; Undo of a deleted answer works from any chat; an approval's Undo clears only its own toast (H2, M5)
- [x] Contract for phase 2: chat id and quote on `ask`, send into a running answer with a priority, interrupt, `createChat`, async methods with pending and error, notifications and the approver from the agent, no crash with zero chats (H8, H10)
- [x] Mock: a routine needs a schedule phrase and a time, Regenerate and Edit don't duplicate routines or skills, seeded chats regenerate to their own answer, each answer's steps and time come from its trace, the off-script answer per D8 (H4, H5, M10)
- [x] One demo clock, one time and date format, one locale per D5; Slack per D6; facts line up across screens (M33, M34, M35, L11)
- [x] Your name and the cap come from Settings everywhere, and a new cap never rewrites what was spent (M15, M39)
- [x] First day and Loading are real states for every page's data, and pause and disconnect flow to counts and tool pages (M16, M17)
- [x] Phase 1 memory per D7 (M14)
- [x] A "page not found" notice and a production crash screen (reload, message the team) (M18)
- [x] Stubs say what they are: "Not connected in this demo" instead of "Downloaded" (M36)
- [x] Reset demo also resets the stage and scenario (found while testing PR 1)
- [x] Moved in from PR 2: the skip link and a banner landmark for the top bar (L18), the persona identifier rename (L16), the README's stale lines (L17)

Files: `src/state/*`, `src/agent/*`, `src/agent/sample-data/*.json`, `src/shell/TopBar.tsx`, `src/shell/Toasts.tsx` (new), `src/overlays/Menus.tsx`, `src/App.tsx`, `src/ErrorBoundary.tsx`, `README.md`.
Risk: high. Run lifecycle and Undo are the sensitive piece.
Verify: E2E: approve two drafts five seconds apart and undo both from their toasts, delete two routines and undo both, ask, leave mid-answer and come back, reload and find the draft and the started chat, ask an off-script question. `sample-data.spec.ts` gains checks that times, counts and amounts agree across screens.

Notes from the build:
- **Verified.** Built in three phases (A: state, contract and mock; B: data; C: the screen edits), then code-reviewed (the store, toasts and Undo, and the mock and data) and visually checked on every changed shot, light and dark, desktop and phone, before the baselines were updated. New specs: `toasts`, `run-lifecycle`, `memory`, `mock-behaviour`; `sample-data` checks that weekdays, times, counts, amounts, connect dates and names agree across screens.
- **Contract additions** (`src/agent/types.ts`, phase 2 builds against it): `ask(text, { chatId, quote, replacesRun })`, `send(runId, text, { priority })`, `interrupt`, `createChat`, `allChatIds`, `listNotifications`, `by` on approval, set-aside and undo records, `AgentData.status` (`'loading'`), `tools.channels`. Writes are async: they revert, reject with an `AgentError` and send a notice; callers that need a value at once (`approve`, `undoHandled`, `pause`, `runRoutine`) are documented. Take-back: a Regenerate removes what the replaced run made (a routine is soft-deleted through `routinesDeleted`, and Regenerate's Undo restores it); a failed answer takes nothing back and carries its routine on; skills are never taken back.
- **Storage keys:** `inhouse.ui.session.v1` (chats started, additions to every chat, drafts, the Library view; sanitized on load, cleared by Reset demo), `inhouse.demo.v2` (the mock's state), `inhouse.demo.runs.v1` (run id to trace), `inhouse.demo.switches.v1` (stage and scenario), `inhouse.ui.sidebar.v1`, `inhouse.theme`, and `inhouse.crash.v1` in session storage for the crash screen.
- **The demo clock** (`src/agent/clock.ts`): Monday, November 16, 2026, 8:00 AM, device-local, saved at first load and moving on from there. The Settings time zone is a label, not a clock shift. Times carry a no-break space before AM or PM, so a time never wraps; anything that matches, searches, copies or exports a time must allow for it (`plainSpaces` for copies, the audit CSV and Activity's search). Lists show a time for today, a weekday for the six days before ("Fri, Nov 13"), a date for older. Sort on the stored values (`atMin`, ISO `at` and `iso`), never a shown string.
- **Runs per chat** (D9): `runs` by chat id in the store, `updateChat` the one writer, a chat's additions move with its id in the same `set`. Leaving a chat mid-answer lets it finish in the background (the sidebar's running dot); a reload mid-answer adds an "interrupted" note once.
- **Toasts** (`src/shell/Toasts.tsx`; full rules in `DESIGN_APP.md`): a stack of at most four, plus one when a notice would push out an Undo, so never more than five. Approvals going out share one keyed toast whose count follows them. F6 reaches the newest toast with no trap; **while a modal is open F6 does nothing** (the modal keeps focus; a toast's Undo still takes a click). Toasts never remount, so a countdown can't stick.
- **First day and Loading are data**, not screen branches: the mock empties tools, usage, files and notifications and sets `status`; chats, problems and the rest stay so no screen crashes. Pause and disconnect flow through `toolState` and `toolView` to counts, Today and the tool pages.
- **Slack is a channel** (`tools.channels`), not a tool in "Add a tool"; it's shown from Act, and text says "Chats" or "Chats and Slack" by stage.
- **Usage history:** September and October were removed (they showed spend before the first tool was connected on Nov 2), so there's one month and the month picker is hidden below two months. A $0 day draws a baseline tick. Undecided: keep it so, or bring the months back and move the tools' connect dates to September.
- **Calls made:** the demo date (the nearest 2026 Monday keeps every weekday in the story true); PR 2 merged first, and the skip link, banner landmark, persona rename and README moved in from PR 2; work rows removed from chats (the steps line links the trace); PO-1187 at $5,100 everywhere; dictation's fake flow removed; the top bar fixed above the page; a notice never pushes out an Undo; F6 simplified after review; the Cap reached scenario has its own usage data in the normal shape.
- **For PR 4 to 7:** PR 4, the 6:08 AM ShipBob draft and the 7:42 AM stuck-orders chat draft the same message (accepted for now), "Approved by" vs the over-$5,000 rule reads oddly, the Approvals "Approved today" rows on a phone (H7). PR 5, the steps line sits at the row's left edge only while the hover actions are hidden; a trace id per turn for phase 2; the selection bar covers the last All chats row on a phone. PR 6, the xlsx card cuts its chat name; file names and meta lines cut on a phone. PR 7, descriptions cut on Skills and Tools; Morning check's "Last run" on the chip line; Routines cards on a phone; a tool page's Read and Draft "Off" vs Access in Tool disconnected; the Routines sheet's time column has no visual state.

## PR 4: Today, Approvals and the review panel

- [x] Card footers never cut: the amount line and the draft or suggestion line wrap (H1, M1)
- [x] One "Drafted" style; the header follows the state ("All approved"); handled cards use the muted token (M21, L15)
- [x] Approvals: one primary action, Review, and "···" (Edit, Don't send); Edit always opens the panel with the draft in view; low-risk cards are marked; one footer pattern; one dismiss verb (M6, M7)
- [x] "Approved today" rows reflow on a phone (H7)
- [x] Panel: actions on one row, nothing hidden under the ask bar (M28)
- [x] Today card: a stretched button, not a click handler on a `div` (M38)
- [x] First-day and loading states for Approvals
- [x] Phone: no fixed card height, header on one line, no sort control, Approve plus "···" (M25, M27)

Files: `src/screens/Today.tsx`, `src/screens/Approvals.tsx`, `src/overlays/ProblemPanel.tsx`, specs.
Risk: medium. The demo's first screen.
Verify: E2E at Watch, Act and Run: every card's text fully visible at 390 and 1440 (no element with `scrollWidth > clientWidth`), edit a no-text draft in the panel and approve it, approve all low-risk and undo.

Notes from the build:
- **Not run here.** Built by a worker that can't start a browser: typecheck and lint pass; the E2E, visual and a11y suites and the screenshot check are the orchestrator's. New specs: `today-approvals.spec.ts` (1440: no text cut on Today and Approvals at Watch, Act and Run; Edit on a no-text draft in the panel, approve, Undo keeps the note; Approve all low-risk and its toast Undo; the Today card opens from its title and its menu doesn't) and `today-approvals-phone.spec.ts` (390: the same no-cut check, no sort, one header line, Approve plus "···", an approved row that reflows). Shared helpers in `e2e/today-approvals-helpers.ts`.
- **Approvals cards** mirror Today: low-risk drafts (no money, no customers) get one-tap Approve and a "Low risk" badge; the rest get Review, which opens the panel where the Approve button is. "···" holds Edit and Don't send (and Review on a low-risk card). The note about who usually signs off moved above the buttons. Specs that approved a money or customer draft from its card now go through the panel (`page-actions.spec.ts`, the `act-today-approved` state in `states.ts`).
- **Edit** always opens the panel. A draft with no text of its own shows a "Your note" field (stored through `editDraft`, shown on the card after, and kept through Undo). `draftView` now returns `agent.edits[id] ?? dr.body ?? null` and labels such a note "Your note" (`src/state/derive.ts`, additive).
- **The panel's actions** (Approve, Edit or Done, Don't send) sit on one row in the footer above the ask bar, so they never scroll out of reach. "Not now" is gone; Don't send is the one dismiss verb (Today's "Not a problem" stays: it means the problem isn't one, not the draft).
- **Today's header follows the state:** "Needs you", then "All approved" or "Nothing waiting" (with the set-aside count) once nothing waits. Handled and approved cards use `text-done` for the status line too. One Drafted style: "Drafted · ready to approve", "Drafted · <what waits>", and the panel's "Drafted · title". On a phone the sort control is gone, cards have no min height, and the Approvals header keeps one line.
- **Leftovers settled:** "Restocked 11 units" keeps a no-break space after the number in the handled banner; "usually approves" became "Dana Kim usually signs off orders over $5,000. As an admin, you can approve it in Dana's place." (and the same for Leo's customer emails) so "Approved by Sam" reads right (`problems.json`); the 6:08 AM and 7:42 AM drafts stay as accepted.
- **Expected visual changes:** Today (Watch, Act, Run, first day, loading, cap, all approved), Approvals (Watch unchanged), the problem panel, and their phone shots; Approvals first-day and loading are new states but not added to `states.ts`.


## PR 5: Conversation and composer

- [ ] Answer presentation per D2: one white card per answer turn with text, tables, drafts and routines inside it (drafts and routines as inset blocks, hairlines around tables), the person's message a soft grey bubble, lines near 75 characters, one link to the steps (M9, M10)
- [ ] Long messages collapse to about eight lines with "Show more" (M8)
- [ ] Queue and steer: a message sent mid-answer shows as a queued chip above the composer (edit, send now, remove), "send now" interrupts, and Stop stays its own button (H8)
- [ ] Edit message shows an "Editing" state with cancel; a stopped answer has Retry (M11)
- [ ] Jump-to-latest clear of the sources; the multi-line field fades at its top edge; Send stays inside the composer at 768px; the title's focus box (M12, M13)
- [ ] A new chat gets a short title (L8)
- [ ] Trace window: wider names on desktop, a plain step list on a phone (H6, L9)
- [ ] All chats: a real empty state, newest first (M19, L11)
- [ ] Phone: mic and logo stack out, model into "+", action row per D3 (M27)

Files: `src/screens/Chats.tsx`, `src/screens/chat/*`, `src/components/Composer.tsx`, `src/ui/chat.tsx`, `src/overlays/TraceWindow.tsx`, specs.
Risk: medium to high. The most-used surface, and D2 changes its look.
Verify: E2E: paste a one-page message and expand it, queue a message mid-answer then send it now, edit and cancel, open the steps on a phone and read every step name. A frame-by-frame check (30 fps) of sending, streaming and finishing: no scroll jump.

## PR 6: Library

- [ ] Phone: one list, sort and type in a filter sheet, no previews in rows (M23, M27)
- [ ] 768 to 1024px: places collapse to chips before the files column gets squeezed (M23)
- [ ] List view gives names the spare width (M23)
- [ ] No-results with Clear, and counts that follow the search (M19)
- [ ] Dark: previews get a dimmed frame (M22)
- [ ] Viewer on a phone scrolls code instead of wrapping it; an open file has its own link, so Back closes it (L13, L19)
- [ ] First-day and loading states

Files: `src/screens/Library.tsx`, `src/screens/library/*`, specs.
Risk: low to medium. One screen.
Verify: E2E: search with no results and clear it, switch place and type, open and page through files at 390, 768 and 1440 with no name cut where there's room.

## PR 7: Pages and windows

- [ ] Tools and Skills: descriptions on two lines, no ellipsis; one way to request; the tool page's question rows without the repeated chip; paused and disconnected read as such; no orphan "Suggested" heading (M2, M17, M19, L3, L4)
- [ ] Routines: a row that fits a phone, an icon that says something or none, a "Last runs" list with results (M24, L1, L2)
- [ ] Usage: the agent mark on the agent's row, phone columns (L5)
- [ ] Settings: Models explains each model and why Smart is locked, one "How hard it thinks" label; Audit log rows on one edge; phone edges; phone controls per D4 (M31, M32, L12)
- [ ] Activity: phone rows and "Open a line" (L15)
- [ ] Team window: styled resize, no mid-word quote (L10)
- [ ] First-day and loading states for each of these pages (M16)
- [ ] Copy sweep (L15)

Files: `src/screens/Routines.tsx`, `Tools.tsx`, `Skills.tsx`, `Usage.tsx`, `Activity.tsx`, `Settings.tsx`, `src/screens/settings/content.ts`, `src/overlays/TeamWindow.tsx`, specs.
Risk: low. Many small fixes over six pages.
Verify: E2E: pause a tool and see Read and Draft change, open every page on first day and while loading, run a routine and see its result line, on a phone and on desktop.
