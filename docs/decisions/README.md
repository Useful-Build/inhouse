# Decision records

One short record per decision that shaped this repo: its context, the decision and what follows from it. Each links
the plan section it came from. Ids are unique and never reused. A changed decision gets a new record that says which
one it replaces.

The plans and the UI tracker gave decisions their own ids, and those collided (the UI tracker's D1 to D9 and the setup
plan's D1 to D6). This table is the one place an old id resolves. A bare `D<n>` in code or app docs is the UI
tracker's.

| Record | Decision | Was |
|---|---|---|
| [0001](0001-base-variants-upstream-or-wrapper.md) | Base variants: upstream what any app needs, wrap the rest | UI plan 2 D1 |
| [0002](0002-one-card-per-answer.md) | One card per answer | UI plan 2 D2 |
| [0003](0003-phone-answer-actions.md) | Phone answer actions: Copy, steps and a menu | UI plan 2 D3 |
| [0004](0004-phone-team-settings-read-only.md) | Team settings are read-only on a phone | UI plan 2 D4 |
| [0005](0005-us-formats-one-demo-clock.md) | US formats and one demo clock | UI plan 2 D5 |
| [0006](0006-slack-is-a-connected-channel.md) | Slack is connected in the demo, as a channel (superseded by 0025) | UI plan 2 D6 |
| [0007](0007-phase-1-memory-in-local-storage.md) | Phase 1 memory in local storage | UI plan 2 D7 |
| [0008](0008-off-script-answer.md) | What the agent says to an off-script question | UI plan 2 D8 |
| [0009](0009-leaving-a-chat-finishes-the-answer.md) | Leaving a chat mid-answer finishes it in the background | UI plan 2 D9 |
| [0010](0010-integration-branch-per-project.md) | One integration branch per big project | Setup D1 |
| [0011](0011-workers-previews-from-trusted-workflow.md) | Per-PR Workers Previews, deployed by a trusted workflow_run | Setup D2 |
| [0012](0012-public-preview-urls.md) | Public preview URLs | Setup D3 |
| [0013](0013-rulesets-as-committed-json.md) | Branch rulesets as committed JSON, with no bypass | Setup D4 |
| [0014](0014-global-skills-follow-the-repo.md) | Global skills follow once the flow has shipped | Setup D5 |
| [0015](0015-one-cloudflare-token-in-environments.md) | One Cloudflare token, held in GitHub environments | Setup D6, PD5 |
| [0016](0016-ship-recording-and-exact-sha-approval.md) | Ship recording, and approval of the exact SHA | Setup landing flow |
| [0017](0017-hardening-before-the-backend.md) | Harden the demo first, plan the backend separately | PD1 |
| [0018](0018-custom-domain-indexable-demo.md) | A custom domain, and the demo is indexable | PD2, PD3 |
| [0019](0019-deploy-on-merge-with-rollback.md) | Deploy on merge, with rollback by version id | PD4 |
| [0020](0020-client-errors-into-workers-logs.md) | Client errors go to Workers Logs | PD6 |
| [0021](0021-monitoring-and-runbook.md) | Monitoring: a scheduled check, a runbook and (not built yet) Web Analytics | PD7 |
| [0022](0022-icon-font-subset.md) | Subset the icon font | PD8 |
| [0023](0023-repo-security-settings.md) | Repo security settings | PD9 |
| [0024](0024-issues-only-contributions.md) | Issues welcome, outside PRs not accepted | PD10 |
| [0025](0025-slack-is-a-connected-tool.md) | Slack is a connected tool the agent reads, and a channel from Act (supersedes 0006) | P5 |
| [0026](0026-one-agent-replaces-watch-act-run.md) | One agent with a proactive switch replaces Watch, Act and Run | Master plan 2026-11-24 |
| [0027](0027-learn-from-executor-dont-run-it.md) | Learn from Executor's sign-in code, don't run it | Connect any tool 2026-11-26 |

`PD` ids are the [production plan](../plans/2026-11-19-production.md#decisions)'s. The
[backend plan](../plans/2026-11-19-backend.md#decisions)'s `BD1` to `BD13` don't collide and stay in that plan until
its phases land; each becomes a record here then.

## Backend spike and phase records

The backend's spike and phase results are records too, named by the phase that made them rather than numbered, because
the phase plans link them by name. Each states what was tested, the numbers, the verdict and what it changed in the
[backend plan](../plans/2026-11-19-backend.md).

| Record | What it settled |
|---|---|
| [p0-s1-runner](p0-s1-runner.md) | The runner on `ctx.container`, session store, deferred calls and sizing (standard-4 pool) |
| [p0-s2-container-guards](p0-s2-container-guards.md) | Container guards, the locked built-in tools and skills, PDF and spreadsheet |
| [p0-s3-previews](p0-s3-previews.md) | Worker Previews: alarms and per-PR D1 work, containers didn't start |
| [p2-previews-retest](p2-previews-retest.md) | Wave 0 retest: containers do run in Previews, and Access with a service token works |
| [p0-s4-connector-hub](p0-s4-connector-hub.md) | The connector hub is our own gateway Worker; Shopify reads and Slack's MCP server |
| [p0-s5-memory-tool-choice](p0-s5-memory-tool-choice.md) | Memory recall and tool choice eval, and the softer memory rule |
| [p3-local-containers](p3-local-containers.md) | S6: the SDK sandbox can't start under `wrangler dev` (Mac or GitHub runner); decision Q2 applies |
