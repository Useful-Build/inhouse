# 0011. Per-PR Workers Previews, deployed by a trusted workflow_run

- Status: accepted, 2026-11-19
- Was: setup plan D2
- Plan: [setup plan, Decisions](../plans/2026-11-19-setup-gaps.md#decisions)

## Context

QA and the ship recording need each PR running at a real URL. Deploying needs a Cloudflare token, and a workflow that
runs PR code must never hold one.

## Decision

`ci` builds the app with no secrets and uploads it. `preview.yml` runs on `workflow_run` of `ci`, so its code is
always `main`'s, and deploys that build with `wrangler preview --name pr-<n>` (Workers Previews, open beta). It
comments one URL that follows the PR, one fixed to the commit and the head SHA. Fallback if the beta blocks: Version
URLs. No `pull_request_target`.

## Consequences

- The build is PR-controlled, so the deploy job treats it as hostile: only plain files under `dist/` and the Vite
  plugin's redirect file get through, the generated wrangler config must match `main`'s field by field, and wrangler
  runs from `main`'s `node_modules` with no `.env` and no endpoint overrides.
- A PR that changes `wrangler.jsonc` or bumps wrangler gets no preview until it merges. Fork and Dependabot PRs get
  none.
- `preview-cleanup.yml` deletes the previews of closed PRs daily.
