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
list on Approvals, the menus and every other screen.

The mockups draw a page ground, a greeting, a composer and page headers **only as context** so the cards can be
judged in place. Their colors, sizes and spacing are not part of this spec. Don't restyle them. Where a mockup
value differs from an existing token, use the token (see Tokens).

## Where the design is

- `2026-11-21-needs-you-cards-and-panel/reference/`: the six final mockup files (desktop and 390px phone for Today,
  Approvals and the panel, each drawn in light and dark). They're source files for a design canvas runtime, not
  code to paste: read them for exact structure, copy, sizes and spacing. `/_blob/...` image URLs in them are the
  logos from `app/public/logos/` (Shopify, Amazon, ShipBob, Xero).
- `2026-11-21-needs-you-cards-and-panel/screenshots/`: the approved desktop screens. `today-cards-light.webp` was
  taken before the risk tags were added to the Today cards (see Today cards below for the final tags).
- The live design canvas (page "Final") is Wasim's private artifact. Ask him for the link if you need it.

## Decisions, and why

- **No severity dots anywhere in these three components.** Urgent problems get a red **Urgent** pill that leads
  the card's label. Anything else gets no marker: with two levels, no pill already means "not urgent". The dot
  inside a tinted pill said the same thing three times and read as a template.
- **On Today, the draft is part of the card.** Each card shows the problem, then the drafted fix on a faint
  brand-tint sheet. In this app the brand blue means "your agent", so the tint marks the agent's work.
- **Approvals keeps one card per item in a single column**, its current structure, with the same parts as Today.
  It's a queue, so the draft is the headline there.
- **The panel shows the draft as a document**, cuts the footer to two actions and moves Edit and Ask to where they
  belong.
- **One risk vocabulary** on both pages and in the panel.

## Tokens

Use existing tokens and components. Two new app tokens are needed. Register each the repo's way
(`app/src/index.css` in `:root` and `.dark`, mapped in `@theme inline`, plus `app/src/lib/merge-config.ts`):

| New token | Light | Dark | Used for |
|---|---|---|---|
| `--app-draft-sheet` | `#f5f6fe` | `#1d1f2e` | The draft sheet on Today cards and the draft text block on Approvals cards |
| `--app-draft-kind` | `#ffffff` | `#2a2c3c` | The small kind-icon tile on the draft sheet (with a 1px `--border` edge) |

Existing tokens and parts, mapped from the mockups:

| Mockup element | Use |
|---|---|
| Card surface, shadow | `bg-card`, `shadow-card`, `hover:shadow-float` as today. No 1px border on Today cards: the shadow carries the edge |
| Urgent pill | `--destructive-tint` background, `--destructive-text` text, 600 weight, pill radius |
| Risk tag (Spends, Claims, Goes to customers) | Approvals and panel: `Badge variant="warning"`. On the Today draft sheet: plain `text-warning-text` 600, no pill |
| Low risk tag | `Badge variant="muted"` |
| Area label ("Orders", "Stock") | `text-foreground-3`, 13px, 500. No dot |
| Logos | `LogoTile` round, `sm`, overlapping (the composer's stack pattern) |
| Primary action | `Button variant="primary"`. Never wraps (`whitespace-nowrap`) |
| Muted text | `text-muted-foreground`; body text `text-foreground-3` |
| Radii, spacing | The scale only. `lint:tokens` fails on arbitrary values and color literals |

The mockups add a faint top sheen to primary buttons. Treat it as optional polish through the `src/ui` `Button`
wrapper, never by editing `src/components/ui/`.

## Today cards

Desktop: **two columns** (Wasim's call; today it's three). Phone: one column. Six cards then take three rows on
desktop. Card order follows the existing sort ("Most urgent first").

Anatomy, top to bottom (`reference/Final-Today.dc.html`):

1. **Label row**: Urgent pill (urgent only), area label, flexible space, the source logos (overlapping round
   tiles), the existing `⋯` menu (Ask about this, Snooze, Not a problem: unchanged).
2. **Title**, 17.5px, 600, tight tracking, wraps naturally (no `text-wrap: balance`, it broke "(M, / Olive)").
3. **Subtitle**, 14px, `text-foreground-3`.
4. **Amount line**: the amount at 22px 600 tabular, then the cost note in muted 13px.
5. **Draft sheet**, inset 8px from the card's sides and bottom, `--app-draft-sheet`, 16px radius, no border:
   - a header row: kind icon tile, "Draft · {kind}", and on the right the risk text when there is one;
   - the draft title, 14.5px, 500;
   - one summary line, 12.5px, muted, one sentence (no truncation);
   - the action: "Review draft →" opens the panel; a low-risk draft (`lowRiskIds`) shows "✓ {cta}" and approves in
     place, as the Approve button does today.

Spacing pushes the amount line down so amounts and sheets line up across a row. Don't give cards a fixed min-height:
short cards left a large empty gap. Keep the handled and approved states as they are (`text-done`, Undo, no opacity
dimming) and the stretched-title link pattern.

Risk text on the sheet, final copy: "Goes to customers" (oversell), "Claims $1,240" (payout), "Spends $9,600"
(stock). Low-risk drafts show nothing there.

## Approvals cards

One column, one card per item (`reference/Final-Approvals.dc.html`). Structure as today, with these changes:

1. **Header row**: Urgent pill (urgent only), the draft title (16.5px, 600), then on the right the risk tag
   (`warning`) or "Low risk" (`muted`), then "{area} · {time}" in muted. No dot.
2. **Detail lines**: the existing key/value rows (`draftView.lines`), key muted, value 500, hairline between rows.
3. **Draft text** (when `body` exists): on `--app-draft-sheet`, 14px radius. The label in sentence case, muted
   12.5px ("Email to customers, in your tone"), not the monospace capitals.
4. **Approver line** (when there is one): avatar, name in 600, the rest muted.
5. **Action row**: the primary button ("Review draft →", or "✓ {cta}" for low risk), the `⋯` button, and on the right
   "From {sources}" with the logos. This replaces the separate "From Amazon · Xero" line above the buttons.

Section header: "Approve all low-risk" shows its count ("Approve all low-risk 3"). The sort control is unchanged.

## Review panel

`reference/Final-Panel.dc.html`, top to bottom:

1. **Header**: a neutral area chip (`bg-fill`, `text-foreground-2`, no dot, no amber; an urgent problem gets the Urgent pill before
   it), flexible space, an **Ask** button (chat icon and the word "Ask", opens the existing ask flow), the close
   button. "Found at" moves out of the header.
2. **Title**, 27px.
3. **Progress line**: Found {time} ✓, Drafted ✓, **Your approval** (current, `aria-current="step"`), Sent to
   {destination}. Real `<ol>`. Wraps on a phone.
4. **Facts strip**: one card split into three columns by hairlines. Each column: a muted label, a 24px value, a
   12px note with its source number. The third value can take `text-destructive-text` when it's the bad news.
   When a problem has no facts (see Data), show the current "What your Inhouse agent found" paragraph instead.
5. **Sources**: one collapsed row, "How your Inhouse agent worked it out", the source logos and "3 sources", a
   chevron. Expanding it shows today's numbered source list (and the found paragraph when the facts strip is shown).
6. **"Drafted for you"** heading, then **the draft as a document**: a paper surface (`bg-card` in light, one step
   up in dark, `shadow-float`), 14px radius. Header: the kind in small caps ("Purchase order"), a "Draft" chip, and
   **Edit** on the right (moved here from the footer; it toggles the existing edit mode). Then From / To, then the
   lines. A purchase order with structured items renders the item table (Item, Qty, Each, Amount) between two 1.5px
   ink rules, and the total at 24px. Every other kind renders `lines` as key/value rows and `body` as text.
7. **Memory line**: bookmark icon in `--brand`, the remembered sentence, "Manage" link. No tinted box.
8. **Footer** (pinned): the approver line (avatar, name, note, "Ask Dana" as a text button), then **two actions**:
   "Don't send" as a ghost button on the left and the primary filling the rest, with the amount in a quieter weight
   ("Approve and send to Kestrel  $9,600"). The old "Ask about this…" bar is gone; Ask lives in the header.

Phone: the panel stays the bottom sheet it is today (`reference/Final-Phone-Panel.dc.html`). The primary action takes
its own full-width row and "Don't send" sits under it. Facts strip labels shorten ("Delivery", "Out of stock"),
the PO table drops the Each column and shows "$16 each" under the item.

## Phone, 390px

- Today (`reference/Final-Phone-Today.dc.html`): one column, the sheet's action full width at 44px.
- Approvals (`reference/Final-Phone-Approvals.dc.html`): tags and "{area} · {time}" on the first row, the title
  under them, detail rows stacked (key above value), the primary full width with `⋯` beside it, sources above the
  actions. The header button reads "Approve low-risk 3".
- Every tap target is at least 44px.

## Data this needs

The mockups use fields the contract doesn't have yet. Add them in `app/shared/contract/` (zod), the sample data and
the mock agent, with fallbacks so the UI ships without them:

| Field | Example | Fallback |
|---|---|---|
| `draft.kind` | "Purchase order", "Email", "Amazon case", "Shopify change", "ShipBob ticket" | Derive: body present means "Email", else "Draft" |
| `draft.summary` (one line for the Today sheet) | "To Kestrel Supply as a PDF. 400 Olive, 200 Black." | The first `lines` row as "{key}: {value}" |
| `draft.amount` and a direction (spend or claim) | $9,600 spend, $1,240 claim | `waitsLabel` as today ("Spends money") |
| `problem.facts` (up to 3: label, value, note, source number, tone) | "Stock left · 9 days · 190 at 21 a day · 1" | Show the found paragraph |
| `draft.destination` (short name for the progress line) | "Kestrel", "Amazon", "5 customers" | "Sent" |
| `draft.items` (structured PO lines) | Olive, 400, $16, $6,400 | Render `lines` as key/value rows |

`waitsLabel` in `app/src/state/derive.ts` gains a third case: a claim reads "Claims {amount}", not "Spends money".
The payout draft brings money in, so "Spends money" is wrong for it today.

## How to land it

Two PRs, in order:

1. **The visual change on existing data**: no dots, the Urgent pill, tags, the draft sheet, the new card and panel
   layouts, the two tokens, every fallback above.
2. **The new data fields**: contract, sample data, mock agent, then switch the UI from fallbacks to the fields.

## Checks

- `npm run typecheck`, `npm run lint` (including `lint:tokens`), `npm run test:unit` pass.
- Light and dark, desktop and 390px phone, for Today, Approvals and the panel. Compare with the reference files.
- Keyboard: every card action, the `⋯` menus, the panel's Ask, Edit, the sources toggle, Don't send and Approve.
- `npm run test:a11y` passes.
- The visual baselines change on purpose: run `npm run test:visual:linux:update` and commit them. `app/e2e/` is a
  sensitive path, so the PR needs Wasim's OK.
- Update `.agents/skills/verify/feature-map.md` for the changed cards and panel.

## Not decided here

- The three Approvals times after 6:08 in the mockups (6:09 to 6:11) are placeholders. Use the real data.
- Nothing in this spec changes the approved list on Approvals or the Activity page.
