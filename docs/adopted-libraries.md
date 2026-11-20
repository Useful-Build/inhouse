# Adopted libraries

The register of the base libraries the app is built on, one entry per library. An entry says where the library sits in
the code, why we use it, how it's pinned and where its changelog is. Read it before bumping one of these, and add an
entry when a new base library is adopted. Versions live in `app/package.json`, not here.

## Streamdown

**Status: approved 2026-11-20, not yet adopted (build after P3's release).**

**Streamdown** (`streamdown`, exact pin). Layer: chat markdown rendering (`src/screens/chat/markdown/`). Why: half-written markdown, GitHub markdown and a layered sanitizer, maintained by Vercel; chosen over react-markdown, markdown-to-jsx, Comark and Markstream on 2026-11-20 (plan file). Configured: `skipHtml`; rehype = defaults minus `raw`; harden `allowedLinkPrefixes ['*']`, `allowedProtocols []`, `defaultOrigin` = app origin, `allowedImagePrefixes []`, `allowDataImages false`, link and image block policy `text-only`; `mode="streaming"`, `parseIncompleteMarkdown` and `isAnimating` only while live; one block plus our numbering plugin; `controls={false}`; `linkSafety` off; remark = defaults + `remark-breaks`. Overrides: `a` (https/mailto/# only, new tab for https, maps `#user-content-/` to `#/` because of 2.8.0's `undoubleClobberPrefix`, reported upstream as https://github.com/vercel/streamdown/issues/767; when building, check whether a fix has shipped before relying on this workaround), `strong`, h1-h6 shifted one level, code block and table wrappers (regions, names, Copy), every styled element on our tokens; `>` quote pre-step. Not used: `@streamdown/code`, math, mermaid, cjk, `animated`, built-in controls, link safety modal. Changelog: https://github.com/vercel/streamdown/releases. Guarded by: `streamed.property.test.ts`, `markdown.differential.test.ts`, `conversation.spec.ts`.

## In use

**shadcn/ui base and Radix** (`radix-ui`, caret range; shadcn is copy-in code, config in `app/components.json`, style `new-york`). Layer: `app/src/components/ui/` (the base's components, built on Radix primitives). Changelog: https://ui.shadcn.com/docs/changelog and https://www.radix-ui.com/primitives/docs/overview/releases. Companions: `class-variance-authority` and `tailwind-merge`.

**zustand** (`zustand`, caret range). Layer: UI state, `app/src/state/store.ts`. Changelog: https://github.com/pmndrs/zustand/releases.

**zod** (`zod`, exact pin). Layer: schemas at the Worker and the agent HTTP boundary (`app/server/auth/config.ts`, `app/server/db/handler-kit.ts`, `app/src/agent/http/transport.ts`). Changelog: https://github.com/colinhacks/zod/releases.

**jose** (`jose`, exact pin). Layer: sign-in, verifying the Cloudflare Access JWT in `app/server/auth/authenticate.ts`. Changelog: https://github.com/panva/jose/releases.

**cmdk** (`cmdk`, caret range). Layer: the command palette, `app/src/components/ui/command.tsx` and `app/src/overlays/CommandPalette.tsx`. Changelog: https://github.com/dip/cmdk/releases.

**Tailwind** (`tailwindcss` and `@tailwindcss/vite`, caret ranges; v4). Layer: styling, `app/src/index.css` and the Vite plugin in `app/vite.config.ts`. Changelog: https://github.com/tailwindlabs/tailwindcss/releases.

## Per-update procedure

1. Dependabot: the `registered` group in `.github/dependabot.yml` matches `streamdown`, `@streamdown/*` and
   `remark-breaks`. A dependency goes to the first group it matches (docs.github.com Dependabot options reference, read
   2026-11-20), so these bumps arrive alone. The npm entry has `cooldown: default-days: 14`, which applies to version
   updates only. Security updates still come at once.
2. On each such PR, read every release note between the old and new versions and write in the PR: breaking changes and
   deprecations that touch our settings or overrides, security fixes, and new features worth adopting. Check whether
   `defaultRehypePlugins` gained or lost a key, since we filter it.
3. Run the full CI and E2E. Merge only the bump. A feature gets its own PR.
4. If any kept rule weakens (the property tests or the differential fail, or a default moves), stop and report. Don't
   patch around it inside the bump.

## Periodic re-scan

At the two-month setup review (first 2027-01-15), per layer (markdown, chat UI kit, UI base, state, validation),
search current sources, not this register's list. Report keep, upgrade or switch, with dated evidence and measured size.
