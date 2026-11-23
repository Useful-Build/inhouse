# DESIGN.md - Inhouse

## 1. The design bar

Every screen must be effortless to use without instructions (one clear primary action, minimal steps, must-haves only) and finished to a high craft. Fewer elements, each one sharp; fewer words, never sloppy. Design real interactive states (default, hover, focus, active, disabled, loading, empty/error) using realistic content, with full keyboard navigation, visible focus rings, reduced-motion support, and zero clipped text or sideways scroll at 390px and 1440px.

## 2. Inhouse look and palette

Pure gallery monochrome for ~95% of chrome (Obsidian and Slate Ink: `#fafafa` / `#111113` canvas, `#ffffff` / `#19191c` cards, `#151517` / `#ededef` ink) paired with quiet deep Sapphire as the sole brand accent (`#1f44a8` light, `#7b9ef0` dark), harmonized amber warning, terracotta destructive, and `--app-success` green.

Typography is self-hosted Geist and Geist Mono; icons are Material Symbols Rounded; surfaces separate via hairlines and calm elevation. Today and blank New chat use `SkyspaceBackground`. Never add decorative gradients, neon glow, glassmorphism, emoji icons, or decorative status dots on badges.

## 3. Ownership: ui-base vs Inhouse

Inhouse runs on `Useful-Build/ui-base` (shadcn/ui on Radix + Tailwind v4).

- Base-owned (never edit): `app/src/ui-base.css`, `app/src/components/ui/*.tsx` (except `icon.tsx`), `icon-names.ts`, `app/src/lib/utils.ts`, `app/scripts/check-tokens.mjs`, `app/DESIGN_SYSTEM.md`.
- App-owned (edit here): `app/src/index.css`, `app/src/components/ui/icon.tsx`, `app/src/lib/merge-config.ts`, `app/src/ui/`, `app/scripts/check-tokens.allow.json`, `app/e2e/ui/routes.ts`, `app/DESIGN_APP.md`.
- The base's regression suite (`playwright.ui.config.ts`, see `app/DESIGN_SYSTEM.md`) is a heavy Playwright run: run it in CI or a cloud runner, never on Wasim's laptop (`VERIFY.md` §6).
- Updating the base: `npx shadcn@4.23.0 add ui-base/update -y --overwrite` (see `app/DESIGN_SYSTEM.md`; never re-add `base`).

## 4. Hard UI rules (enforced by `npm run lint`)

- Tokens only: never write hex colors, `rgb()`, named CSS colors, or stock Tailwind palette classes (`bg-zinc-100`, `text-red-500`) outside `ui-base.css` and `index.css`. Use semantic role classes (`bg-card`, `text-muted-foreground`, `border-border`).
- New app tokens: name them `--app-*`, set values in both `:root` and `.dark` in `src/index.css`, map them in `@theme inline`, and register their class in `src/lib/merge-config.ts` so `cn()` keeps them.
- No arbitrary values or static inline styles: avoid `w-[330px]` or literal `style={{ ... }}` in `.tsx`. Only data-computed styles (such as a chart bar height) pass.
- Components and icons: screens import from `src/ui/` (not `components/ui/` directly) and render icons through `<Icon name="..." />`. Always use Radix primitives for dialogs, menus, popovers, sheets, selects, tooltips, and accordions. Never use native `title` tooltips.

## 5. Dark mode

Dark is decided per token, never inverted. Every `:root` override in `src/index.css` needs an explicit `.dark` counterpart. Surfaces climb in cool obsidian steps: page `#111113`, card `#19191c`, window/panel `#1f1f24`, menu/popover `#242429`. Keep hover (`bg-accent`), open, and selected (`bg-fill-hover`) distinct with at least 4.5:1 text contrast. Never dim locked or handled content with opacity; use `text-foreground-3` or `text-done`.

## 6. UI copy and house voice

- Short, plain, declarative sentences. Use contractions (`it's`, `don't`, `you're`).
- Sentence case for all headings, buttons, labels, nav items, and dialog titles.
- Buttons are verb plus object ("Save changes", "Approve draft", never "Submit", "Click Here", or "Get Started").
- No em or en dashes, no exclamation marks, no emoji, no Oxford comma in UI copy ("X, Y and Z"), and no AI hype words (`seamless`, `supercharge`, `unleash`, `effortless`, `elevate`).
- Never add helper text or subtitles that restate the heading; only add helper text when it prevents a real user mistake.

## 7. Deep lookup references

- Base token catalog and scales: `app/DESIGN_SYSTEM.md`
- Inhouse `--app-*` table, z-index layers, window/toast rules, and `src/ui` props: `app/DESIGN_APP.md`
