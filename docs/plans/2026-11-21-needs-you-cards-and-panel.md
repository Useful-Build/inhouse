# Needs you cards, Approvals cards and the review panel: design hand-off

Status: design approved by Wasim on 2026-11-21. Not scheduled. Build it when the roadmap reaches it.

This is a visual redesign of three components. It's a hand-off for a coding agent: what to build, which tokens to
use, what data it needs and how to check it. The mockups live in the folder next to this file.

## Scope: read this first

Change only these three things:

1. **The Today cards**: the "Needs you" cards under the composer (`app/src/screens/Today.tsx`, the `today-card`
   articles inside `CardGrid`).
2. **The Approvals cards**: the cards in the "Waiting for you" list (`app/src/screens/Approvals.tsx`).
3. **The review panel** both pages open (`app/src/overlays/ProblemPanel.tsx`).

**Leave everything else exactly as it is.** That includes the page backgrounds and the dot grid, the greeting, the
composer, page titles and subtitles, the "handled before you woke up" banner, the sidebar and shell, the approved
list on Approvals, the Activity page, the menus and every other screen.

The mockups draw a page ground, a greeting, a composer and page headers **only as context** so the cards can be
judged in place. Their colors, sizes and spacing are not part of this spec. Don't restyle them. Mockup sizes are
design values: build with the tokens and scale steps this spec maps them to. **Where this spec and a mockup
disagree, this spec wins.**

## Where the design is

- `2026-11-21-needs-you-cards-and-panel/reference/`: the six final mockup files (desktop and 390px phone for Today,
  Approvals and the panel, each drawn in light and dark). They're source files for a design canvas runtime, not
  code to paste: read them for structure, copy and proportions. `/_blob/...` image URLs in them are the logos from
  `app/public/logos/` (Shopify, Amazon, ShipBob, Xero). The `columns` prop in `Final-Today` is a canvas control
  only.
- `2026-11-21-needs-you-cards-and-panel/screenshots/`: the approved desktop screens. `today-cards-light.webp` was
  taken before the risk text was added to the Today cards (see Today cards below).
- The live design canvas (page "Final") is Wasim's private artifact. Ask him for the link if you need it.

## Decisions, and why

- **No severity dots anywhere in these three components.** A problem is urgent when `sevClass(p.sev)` is
  `bg-destructive` (the sample data's `b23c22`); add an `isUrgent(sev)` helper next to `sevClass` in
  `app/src/ui/severity.ts`. Urgent problems get a red **Urgent** pill that leads the card's label. Anything else
  gets no marker: with two levels, no pill already means "not urgent". The dot inside a tinted pill said the same
  thing three times and read as a template. `sevClass` stays for any other screen that uses it.
- **On Today, the draft is part of the card.** Each card shows the problem, then the drafted fix on a faint
  brand-tint sheet. In this app the brand blue means "your agent", so the tint marks the agent's work.
- **Approvals keeps one card per item in a single column**, its current structure, with the same parts as Today.
  It's a queue, so the draft is the headline there.
- **The panel shows the draft as a document**, cuts the footer to two actions and moves Edit and Ask to where they
  belong.
- **One risk vocabulary** on both pages and in the panel.

## Tokens and scale

Use existing tokens and components. Three new app tokens are needed. Register each the repo's way
(`app/src/index.css` in `:root` and `.dark` where it differs, mapped in `@theme inline`, plus
`app/src/lib/merge-config.ts`):

| New token | Light | Dark | Used for |
|---|---|---|---|
| `--app-draft-sheet` | `#f5f6fe` | `#1d1f2e` | The draft sheet on Today cards and the draft text block on Approvals cards |
| `--app-draft-kind` | `#ffffff` | `#2a2c3c` | The small kind-icon tile on the draft sheet (with a 1px `border-border` edge) |
| `--app-grid-cards-wide` | `repeat(auto-fill, minmax(min(420px, 100%), 1fr))` | same | The two-column Today grid, as a new `CardGrid` size `wide` in `app/src/ui/page.tsx` (`grid-cols-cards-wide`) |

At Today's `page-wide` width (1000px) `wide` gives two columns, and one column on a phone.

Existing tokens and parts, mapped from the mockups:

| Mockup element | Use |
|---|---|
| Card surface, shadow | `bg-card`, `shadow-card`, `hover:shadow-float`, `focus-within:shadow-float` |
| Urgent pill | `Badge variant="destructive"` (already `bg-destructive-tint text-destructive-text`) |
| Risk tag (Spends, Claims, Goes to customers) | Approvals and panel: `Badge variant="warning"`. On the Today draft sheet: plain `text-warning-text font-semibold`, no pill |
| Low risk tag | `Badge variant="muted"` |
| Area label ("Orders", "Stock") | `text-sm text-foreground-3 font-medium`. No dot |
| Panel area chip | `Badge variant="muted"` with the area, no dot, no amber |
| Logos | `LogoTile` round, `sm`, overlapping (the composer's stack pattern) |
| Primary action | `Button variant="primary"`, `whitespace-nowrap` so it never wraps |
| Muted text | `text-muted-foreground`; body text `text-foreground-3` |
| Panel document surface | `bg-popover` (white in light, a step above the panel in dark) with `shadow-float` |
| Document rules (the PO table's top and bottom) | `border-hairline` (1.5px) in `border-foreground` |
| Document kind label ("Purchase order") | `mono-label` |
| Radii, spacing | The scale only. `lint:tokens` fails on arbitrary values and color literals |

Type sizes, mockup to scale (the scale is `2xs` 11, `xs` 12, `sm` 13, `base` 14, `md` 15, `lg` 16, `xl` 18,
`2xl` 24):

| Element | Mockup | Use |
|---|---|---|
| Today card title | 17.5 | `text-xl` (18), semibold |
| Today amount | 22 | `text-2xl` (24), semibold, tabular |
| Card subtitle, detail values | 14 | `text-base` |
| Draft title on the sheet | 14.5 | `text-base`, medium |
| Sheet header, summary line, notes | 12.5 to 13 | `text-sm` (13) |
| Approvals card title | 16.5 | `text-lg` (16), semibold |
| Panel title | 27 | `text-2xl` (24), as today |
| Facts strip value, document total | 24 | `text-2xl` |
| Facts strip label and note | 12 | `text-xs` |

The mockups add a faint top sheen to primary buttons. Treat it as optional polish through the `src/ui` `Button`
wrapper, never by editing `src/components/ui/`. Nothing is dimmed with opacity (`DESIGN_APP.md`): a quieter part
of a label uses a lighter weight, not opacity.

## Today cards

Desktop: **two columns** through `CardGrid size="wide"` (Wasim's call; today it's three). Phone: one column. Six
cards then take three rows on desktop. Card order follows the existing sort ("Most urgent first").

Anatomy, top to bottom (`reference/Final-Today.dc.html`):

1. **Label row**: Urgent pill (urgent only), area label, flexible space, the source logos (overlapping round
   tiles), the existing `⋯` menu (Ask about this, Snooze, Not a problem: unchanged).
2. **Title**, `text-xl`, wraps naturally (no `text-wrap: balance`, it broke "(M, / Olive)"). It stays the card's
   one link: the stretched-title pattern and the `today-card` class stay (e2e uses both).
3. **Subtitle**, `text-base text-foreground-3`.
4. **Amount line**: the amount (`text-2xl`, tabular), then the cost note in `text-sm text-muted-foreground`.
5. **The bottom block**, inset 8px from the card's sides and bottom, `rounded-xl` (the card keeps its
   `rounded-2xl`). What it holds depends on the card's state:
   - **Waiting for approval** (the main case): the **draft sheet** on `--app-draft-sheet`, no border. A header row
     with the kind icon tile, "Draft · {kind}" and, on the right, the risk text when there is one; the draft title;
     one summary line (one sentence, never truncated); the action. "Review draft →" opens the panel. A low-risk
     draft (`lowRiskIds`) shows "✓ {cta}" and approves in place, as the card's Approve button does today.
   - **Approved, handled, or a stage with no drafts**: no tint. The block is `bg-muted` and holds today's status
     line (`c.statusIcon`, `c.status`, the `TONE_TEXT` color, or `text-done` when dimmed) and today's quiet button
     (`c.quiet`: "Ask about this" or "Undo"). Handled and approved cards stay muted with `text-done`, never opacity.

Remove the card's 1px border, its `hover:border-border-strong` / `focus-within:border-border-strong` and the
`min-h-56`: the shadow carries the edge, and focus shows through `focus-within:shadow-float` plus each button's own
focus ring. The amount line sits above flexible space, so amounts and bottom blocks line up across a row without a
fixed height. The two-line `min-h-today-status` stays only inside the status variant.

Risk text on the sheet, final copy: "Goes to customers" (oversell), "Claims $1,240" (payout), "Spends $9,600"
(stock). Low-risk drafts show nothing there. Until the data in PR 2 lands, the sheet shows the fallbacks (see Data),
so PR 1 won't match the mockups' amounts word for word.

## Approvals cards

One column, one card per item (`reference/Final-Approvals.dc.html`). Structure as today, with these changes:

1. **Header row**: Urgent pill (urgent only), the draft title (`text-lg`, semibold), then on the right the risk tag
   (`warning`) or "Low risk" (`muted`), then "{area} · {time}" in muted. No dot.
2. **Detail lines**: the existing key/value rows (`draftView.lines`), key muted, value medium, hairline between rows.
3. **Draft text** (when `body` exists): on `--app-draft-sheet`, `rounded-xl`. The label in sentence case,
   `text-sm text-muted-foreground` ("Email to customers, in your tone"), not `mono-label` capitals.
4. **Approver line** (when there is one): avatar, name in semibold, the rest muted.
5. **Action row**: the primary button ("Review draft →", or "✓ {cta}" for low risk), the `⋯` button, and on the right
   "From {sources}" with the logos. This replaces the separate foot-note line above the buttons.

Section header: "Approve all low-risk" keeps its label, its `done_all` icon, its current variant and its rule (shown
when two or more are low risk), and adds the count (`lowRiskIds(ctx).length`) after the label in muted. The sort
control is unchanged. On a phone the label stays "Approve all low-risk" too (the phone mockup's shorter label is
superseded).

## Review panel

`reference/Final-Panel.dc.html`, top to bottom. It covers the panel's four modes (`draftView(...).mode`):

1. **Header** (every mode): the area chip (urgent problems get the Urgent pill before it), flexible space, an
   **Ask** button (chat icon and the visible word "Ask", accessible name "Ask about this", starting the same ask
   flow as today's bar), the close button. "Found at" moves out of the header into the progress line.
2. **Title**, `text-2xl`, as today, then the cost line as today.
3. **Progress line** (waiting, approved, handled; not watch): a real `<ol>` of four steps: "Found {time}",
   "Drafted", "Your approval", "Sent to {destination}". Done steps get a filled check. In waiting, "Your approval"
   is current (`aria-current="step"`). In approved, "Your approval" is done and "Sent" is done once `dv.sent`. In
   handled, all four are done and the third reads "Handled by your agent". Wraps on a phone. In watch mode, show
   "Found {time}" as plain muted text instead.
4. **Facts strip** (when the problem has facts, see Data): one card split into three columns by hairlines. Each
   column: a muted label, the value, a note with its source number. The third value can take
   `text-destructive-text` when it's the bad news. When a problem has no facts, show today's "What your Inhouse
   agent found" card instead, unchanged.
5. **Sources** (when the facts strip shows): one collapsed row, "How your Inhouse agent worked it out", the source
   logos, "{n} sources", a chevron. Expanding it shows today's found paragraph and numbered source list.
6. **The draft**, by mode:
   - **Waiting**: the heading "Drafted for you", then the draft as a document on `bg-popover`, `rounded-xl`,
     `shadow-float`. Its header: the kind as `mono-label`, a "Draft" chip (`Badge variant="muted"`), and **Edit** on
     the right (moved here from the footer; it toggles today's edit mode and reads "Done" while editing, as today).
     Then From / To. Then a purchase order with structured items renders the item table (Item, Qty, Each, Amount)
     between two `border-hairline` rules with the total in `text-2xl`; every other kind renders `lines` as
     key/value rows and `body` as text (the edit textarea replaces the body while editing, as today).
   - **Watch**: today's dashed "Suggested next step" block, unchanged.
   - **Approved** and **handled**: today's blocks, unchanged.
7. **Notes under the draft**: the memory line (bookmark icon in `text-brand`, the remembered sentence, "Manage" as
   today) as a plain line with no tinted box. `dv.doneNote` keeps today's brand-tint note, placed under the memory
   line.
8. **Footer**, pinned, **waiting mode only**: the approver line (avatar, name, note, "Ask Dana" as a text button),
   then **two actions**: "Don't send" as a ghost button on the left and the primary filling the rest, with the
   amount after the label in `font-normal` ("Approve and send to Kestrel  $9,600"). Other modes have no footer.
   The old "Ask about this…" bar is gone; Ask lives in the header.

Copy keeps the app's straight apostrophe ("Don't send"), whatever the mockups show.

Phone: the panel stays the bottom sheet it is today (`reference/Final-Phone-Panel.dc.html`). The primary action takes
its own full-width row and "Don't send" sits under it. Facts strip labels may shorten ("Delivery", "Out of stock");
the sources row keeps the full "How your Inhouse agent worked it out". The PO table drops the Each column and shows
"$16 each" under the item name.

## Phone, 390px

- Today (`reference/Final-Phone-Today.dc.html`): one column, the sheet's action full width.
- Approvals (`reference/Final-Phone-Approvals.dc.html`): tags and "{area} · {time}" on the first row, the title
  under them, detail rows stacked (key above value), the primary full width with `⋯` beside it, sources above the
  actions.
- Every tap target is at least 44px.

## Data this needs

The mockups use fields the contract doesn't have yet. Add them in `app/shared/contract/` (zod), the sample data and
the mock agent, all optional, with fallbacks so the UI ships without them:

| Field | Example | Fallback |
|---|---|---|
| `draft.kind` | "Purchase order", "Email", "Amazon case", "Shopify change", "ShipBob ticket" | A body means "Email", else "Draft" |
| `draft.summary` (one line for the Today sheet) | "To Kestrel Supply as a PDF. 400 Olive, 200 Black." | The first `lines` row as "{key}: {value}" |
| `draft.amount` and a direction (spend or claim) | $9,600 spend, $1,240 claim | `waitsLabel` as today ("Spends money") |
| `problem.facts` (up to 3: label, value, note, source number, tone) | "Stock left · 9 days · 190 at 21 a day · 1" | Today's found card |
| `draft.destination` (short name for the progress line) | "Kestrel", "Amazon", "5 customers" | "Sent" |
| `draft.items` (structured PO lines) | Olive, 400, $16, $6,400 | Render `lines` as key/value rows |

The risk text these components show comes from a **new helper**, `riskLabel(dv)` in `app/src/state/derive.ts`:
"Spends {amount}" for a spend, "Claims {amount}" for a claim, "Goes to customers", or null for low risk. Leave
`waitsLabel` as it is: the Activity row text reads it (`derive.ts`, the "Nothing has gone out…" line), and Activity
is out of scope.

## How to land it

Two PRs, in order:

1. **The visual change on existing data**: no dots, the Urgent pill, tags, the draft sheet, the new card and panel
   layouts, the three tokens, every fallback above.
2. **The new data fields**: contract, sample data, mock agent, then switch the UI from fallbacks to the fields.

## Checks

- `npm run typecheck`, `npm run lint` (including `lint:tokens`), `npm run test:unit` pass.
- Light and dark, desktop and 390px phone, for Today, Approvals and the panel in each mode. Compare with the
  reference files and screenshots.
- Keyboard: every card action, the `⋯` menus, the panel's Ask, Edit, the sources toggle, Don't send and Approve.
- `npm run test:a11y` passes.
- **E2E specs this changes on purpose.** `app/e2e/` is a sensitive path: list each one in the PR with its reason, and
  get Wasim's OK. Known today:
  - `problem-panel.spec.ts:25` and `today-approvals.spec.ts` (around line 42) use the panel's "Ask about this…" bar
    and the footer's Edit / Done / Don't send row. Ask moves to the header and Edit into the document.
  - `today-approvals-phone.spec.ts:61-65` measures the panel's Edit and Don't send on a phone.
  - `states.ts:126` finds the Approvals button by the exact name "Review"; the label becomes "Review draft".
    Lookups without `exact` (`app.spec.ts`, `state.spec.ts`, `navigation.spec.ts`, `phone.spec.ts`) still match.
  - `dots-and-today.spec.ts` and `dots-and-today-phone.spec.ts` use `.today-card`, which stays.
  - The visual baselines: run `npm run test:visual:linux:update` and commit them with the change.
- Update `.agents/skills/verify/feature-map.md` for the changed cards and panel.

## Not decided here

- The Approvals times after 6:08 in the mockups (6:09 to 6:11) are placeholders. Use the real data.
