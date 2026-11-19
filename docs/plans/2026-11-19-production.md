# Production plan: plan and spec

Status: approved by Wasim, 2026-11-19, scoped to hardening. Built from four parallel audits (app code, security,
backend, delivery), revised after second opinions from Claude Fable 5.2 (xhigh) and GPT 6.2 Sol via Pi (xhigh). Runs
after the setup plan (`docs/plans/2026-11-19-setup-gaps.md`) and lands through its landing flow (integration branch,
previews, QA, ship recording, Wasim's approval of the exact SHA).

## Goal

Make today's Inhouse demo production-grade and readable as a public case study: fast, secure, deployed on merge,
monitored, documented. Nothing about the agent or a backend changes.

## Scope

- In: Project 1 (hardening), below.
- Out, for a separate plan later: the agent contract and the real backend, built on Cloudflare (Agents SDK). The
  contract and backend findings below (A-* and B-*) are recorded for that plan, not acted on here.

## Audit summary (2026-11-19)

Already production-grade: strict TypeScript; one `AgentClient` seam with typed errors, optimistic writes and rollback;
a `RunEvent` stream and trace kinds that map onto a real agent loop; 8 runtime dependencies, all current, `npm audit`
0; gitleaks clean over all 122 commits; SHA-pinned actions, read-only workflow permissions, no `pull_request_target`,
no untrusted input in `run:` lines; sample data invented (`.example` emails, SVG avatars, logo sources recorded);
self-hosted Geist fonts; theme set before first paint; accessibility basics (live regions, skip link, reduced
motion); running cost about $0 on top of Workers Paid; `wrangler rollback` restores assets with the version.

Gaps, by area:

**Performance**
- P-1 high: the icon font is 3.1 MB and preloaded; icons are invisible until it loads. About 92 names are used in code
  plus names that come from data (37 dynamic uses, 28 names in sample JSON).
- P-2 medium: one 834 KB JS chunk (247 KB gzipped), no code splitting, no bundle budget.
- P-3 medium: no cache headers; hashed assets and fonts revalidate on every load.

**Security**
- S-1 high: no CSP, `frame-ancestors`, `nosniff`, COOP or Permissions-Policy.
- S-2 medium: `_headers` doesn't apply to Worker-generated responses.
- S-3 medium: Dependabot security updates, CodeQL and private vulnerability reporting are off; no `SECURITY.md`; the
  workflow token can approve PRs.
- S-4 low: the Actions policy allows any action and doesn't require SHA pinning (the workflows already pin).
- S-5 low: `@emnapi/*` pinned with `^` on a beta (a lockfile-bug workaround).

**Operations**
- O-1 high: no automated production deploy, no link from a deploy to its commit, no releases, `version 0.0.0`.
- O-2 medium: no client error reporting; the crash screen's "Message the team" goes nowhere.
- O-3 medium: no uptime check or alerting; no incident or rollback runbook.
- O-4 low: no custom domain; production sends `noindex`.
- O-5 low: no Core Web Vitals data.

**Case study and repo**
- C-1 medium: no architecture doc or decision records; decision ids collide across `app/UI_PLAN_2.md` (a finished
  tracker), `app/README.md` and the plans.
- C-2 medium: README has no screenshots, live link or topics; nothing explains the agent workflow to a reader.
- C-3 low: no PR template, issue templates or CONTRIBUTING; a stale `ci/fleet-install` branch.

**Agent contract**
- A-1 high: times are display strings and minutes since midnight; money is text.
- A-2 high: the browser owns chat history; the agent only learns ids and titles.
- A-3 high: no revisions or actor ids; concurrent edits overwrite silently.
- A-4 high: the 10-second send hold is a browser timer.
- A-5 high: runs belong to the tab; turns match queued messages by text; no reattach after reload.
- A-6 medium: demo controls sit on the production interface; `store.ts` imports from the mock; `?demo` and the
  sample brand reach every build.
- A-7 medium: reads can't fail (no error status, no retry); `read()` returns everything; `getTrace` is synchronous.
- A-8 medium: settings are loose string keys; the profile photo is a data URL in localStorage.
- A-9 medium: 24 of 50 specs assert sample names and write mock storage keys directly.
- A-10 low: `document.title` never changes with the route; locale fixed to `en-US`.

**Backend inputs (Project 3)**
- B-1 critical: no users, workspaces or roles in the contract; personal and team state mixed in one browser blob.
- B-2 critical: every permission is checked only in the UI; approvers are display names.
- B-3 high: tool connections can't be modelled; tokens have nowhere to live.
- B-4 high: the spending cap is a settings string.
- B-5 medium: members, rules and the audit log are read-only; memory is only "forget"; no agent evals.

## Decisions

Wasim's calls:
- PD1 Scope: this plan is Project 1 (hardening) only. The agent contract and the real backend are a separate plan,
  written later, built on Cloudflare (Agents SDK). This plan's contract and backend findings (A-* and B-*) are kept
  below as inputs for it. Convex is out.
- PD5 Public URL: `inhouse.usefulbuild.com` on the Useful Build zone in Cloudflare (`app.` is left free for Useful
  Build's own app).
- PD6 The deployed demo is the only deployment until the backend plan adds a product deployment. The demo is
  indexable; previews send `noindex`.

My calls (recorded, change any):
- PD7 Production deploy: `deploy.yml`, bootstrapped onto `main` first with `workflow_dispatch` (push and schedule
  triggers only run from the default branch). A build job with no secrets uploads the exact build; a trusted job in
  environment `production` runs `wrangler versions upload --tag <sha>` from the generated config, smokes that Version
  URL, `wrangler versions deploy <id>@100% --yes`, then smokes the live hostname. Routes and the custom domain are
  applied separately with `wrangler triggers deploy`. One concurrency group for deploy and rollback. Rollback by
  explicit version id, rehearsed once. A GitHub release per deploy, tagged `vYYYY.MM.DD.N`. No staging environment
  and no percentage rollout.
- PD7a One Cloudflare token for both trusted workflows (preview and production): the documented "Edit Cloudflare
  Workers" template, scoped to the one account and the `usefulbuild.com` zone, stored in GitHub environments
  `preview` and `production` (deployment branches: `main` only). Replaces the setup plan's preview-only token.
- PD8 Client errors: `/api/client-error` in the Worker (`run_worker_first` for `/api/*`), rate-limited, payload
  scrubbed and size-capped, into Workers Logs. Hidden source maps kept per SHA as a CI artifact and never served.
  Recheck Workers Logs pricing after its 1 December 2026 change.
- PD9 Monitoring: a scheduled check against production (a curl of the page and an asset, plus one tiny read-only
  smoke spec) that notifies Wasim on failure; a keepalive so GitHub doesn't disable the schedule after 60 idle days.
  Core Web Vitals from Cloudflare Web Analytics (page loads; hash routes aren't attributed). A CI bundle budget. A
  short incident and rollback runbook in `docs/`.
- PD10 Icons: subset the font with Google's `icon_names` parameter, keeping the axes in use; keep
  `font-display: block` (swap would show ligature text). A generated manifest of names from source and sample data, a
  CI check against it, and a fallback glyph at the data boundary for unknown names. The typed union lives in
  `src/ui/` (`icon-names.ts` is base-owned).
- PD11 Repo security: Dependabot alerts and grouped weekly version updates (`npm` in `app/`, `github-actions`);
  `pr-gates` skips the trailer check only for PRs opened by `dependabot[bot]` (setup plan, verified login). CodeQL
  default setup, private vulnerability reporting, `SECURITY.md`, the workflow token unable to approve PRs, only
  GitHub-owned and listed actions, SHA pinning required.
- PD12 Outside contributions: issues only, said in CONTRIBUTING (PolyForm Strict).

Inputs for the later backend plan (from the audits and second opinions, not decided here): one brand per workspace
with memberships, workspace scoping enforced on the server on every entry point, stage enforced on the server,
approvers as member ids; the send hold scheduled server-side with an outbox, a defined Undo cutoff and provider
idempotency; budget reserved atomically before every paid model call; Anthropic direct first, Bedrock only after
parity tests; tool tokens encrypted with a versioned key, typed agent actions with server-checked bounds; an
append-only audit log with redacted args; privacy, terms, retention, export and deletion, backups and Shopify's
compliance webhooks before any real merchant data; per-PR isolated data for previews (Workers Previews give Durable
Objects their own storage per preview); the contract findings A-1 to A-10, done additively with the mock green.

## Project 1: hardening (`fleet/hardening`)

Mock only; no backend. Two bootstrap PRs go straight to `main` first (as in the setup plan), the rest through the
integration branch.

Bootstrap into `main`:
- B1 opus-worker: `deploy.yml` and `monitor.yml` per PD7 and PD9 (dispatch plus the real triggers), the Version URL
  and custom-domain setup, `run_worker_first` for `/api/*`, release tagging, `version` set. Rehearse a deploy and a
  rollback on a no-op change before it merges. Owns `.github/workflows/deploy.yml`, `monitor.yml`,
  `app/wrangler.jsonc`, `app/package.json` (version only).
- Orchestrator: repo security settings and files (PD11), `@emnapi` exact pin (S-5), delete `ci/fleet-install`.

Integration branch workers, in parallel:

| Worker | Job | Owns |
|---|---|---|
| H1 sonnet-worker | Headers (S-1, P-3): `script-src 'self'` with the theme script moved to a blocking `public/theme-init.js`; `style-src 'self' 'unsafe-inline'` (Radix scroll lock injects measured styles, so a hash can't hold); `img-src 'self' data:`; `connect-src 'self'` plus the analytics collector; `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`; `nosniff`, COOP, Permissions-Policy (clipboard-write kept). A Playwright fixture that fails any test on a `securitypolicyviolation`. Report-Only first, enforced once a full run and a preview show none. `/assets/*` immutable; fonts revalidate; `noindex` per PD6. Takes H2's and H5's `index.html` changes. | `app/public/_headers`, `app/index.html`, `app/public/theme-init.js`, the CSP fixture |
| H2 sonnet-worker | Icons per PD10. Visual suite passes with no baseline update; cold and failed font loads never show ligature text. | `app/src/ui/` icon union and fallback, `app/public/fonts/`, `app/scripts/check-icons.mjs` |
| H3 sonnet-worker | Bundle (P-2, A-10): Today stays eager; `React.lazy` for the measured heavy routes (Settings, Usage, Library viewer, Trace window); a `vite:preloadError` handler that reloads once and keeps drafts; a gzip budget on initial JS for Today and a deep link; `document.title` per route and focus to the page heading, tested on phone and keyboard. | `app/src/App.tsx`, `app/scripts/check-bundle.mjs` |
| H4 opus-worker | Client errors (O-2, S-2): `window` error and `unhandledrejection` hooks, ErrorBoundary report, route-level boundaries, the Worker route per PD8 with a header helper, hidden source maps excluded from assets; the crash screen links to a real support path. | `app/worker/`, `app/src/ErrorBoundary.tsx`, `app/src/main.tsx`, `app/vite.config.ts` |
| H5 sonnet-worker | Web Analytics beacon (O-5); the incident and rollback runbook. | `docs/runbook.md`; beacon tag handed to H1 |

Orchestrator alongside: the docs PR (C-1 to C-3): `docs/architecture.md`, `docs/decisions/NNNN-*.md` (unique ids;
the UI_PLAN_2 and plan decisions moved in, `app/README.md` updated to cite them), `docs/how-we-build.md`, README
screenshots from the visual baselines plus live link and topics, `app/UI_PLAN_2.md` to `docs/history/`,
CONTRIBUTING, PR template with the Verified trailer and a screenshot checklist.

Browser scenarios for the reel: icons render (desktop, phone, dark); a deep link and back navigation; an old tab
opening a lazy route after a deploy; the crash screen's report flow; first load before and after on a throttled
connection.

## Acceptance

1. Production responses carry the enforced CSP, `nosniff`, COOP, Permissions-Policy and `frame-ancestors 'none'`;
   no test and no preview page reports a CSP violation; menus, dialogs and the phone scroll lock work under it.
2. `/assets/*` is served immutable; `index.html` and the SPA fallback revalidate.
3. The icon font is under 100 KB; the visual suite passes with no baseline update; an unknown name shows the
   fallback glyph; a name missing from the subset fails CI.
4. Initial JS for Today and a deep link is under the budget set from the measured split, and CI fails over it.
5. An old tab opening a lazy route after a deploy (and after a rollback) recovers with one reload and keeps drafts.
6. A thrown error and an unhandled rejection in production reach Workers Logs with the release SHA, rate-limited and
   scrubbed; source maps aren't served.
7. A merge to `main` deploys that SHA (upload, smoke on the Version URL, promote, smoke on the live hostname) and
   creates a release; a rollback by version id was rehearsed.
8. The scheduled check runs against production and a forced failure notifies Wasim.
9. The custom domain serves the demo with HSTS; the repo homepage points to it.
10. Dependabot, CodeQL and private vulnerability reporting are on; `SECURITY.md` exists; the workflow token can't
    approve PRs; unlisted actions are blocked; a Dependabot PR passes `pr-gates`.
11. A reader can follow `docs/architecture.md`, the decision records, `docs/how-we-build.md` and the runbook; the
    README has screenshots and the live link; every decision id resolves to one record.

## Must not

No visual change without an explained baseline update; no secret in a job that runs PR code; no production deploy
from a laptop once `deploy.yml` lands; no real customer data anywhere in the public repo; no backend, contract or
Convex work (the later plan); no paid tier without Wasim's OK.
