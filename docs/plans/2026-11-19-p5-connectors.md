# P5: connectors (`fleet/connectors`)

Status: locked 2026-11-19, pending Wasim's approval to start. Phase plan under the backend plan
(`docs/plans/2026-11-19-backend.md`). Common rules are in its "Phase schedule (waves)" section. P0 record:
[S4](../decisions/p0-s4-connector-hub.md).

## Goal

Connect tools that publish an official MCP server through the hub, let the agent reach large results through code
mode, and make Slack the notification channel.

**Success measure (the real slice):** connect one official MCP tool and ask across it and Shopify.

## Scope

In:
- **OAuth at the hub** for official MCP servers, with the MCP TypeScript SDK's client auth, including pre-registered
  confidential clients (Slack allows no dynamic registration, per the decision log): connect, refresh, revoke, PKCE and
  state checks, one `SignIn` object per connector account, tokens encrypted with H0's key.
- **The callback path.** The browser returns to `/api/connect/callback` on the product Worker (Access-checked), which
  forwards only `code` and `state` to the hub over the service binding. The hub holds the PKCE verifier and exchanges
  the code; no token crosses back. The `state` is one-use and bound to the member who started the connect and to that
  connector account; the callback checks the signed-in member is that member and may still connect tools.
- **Read-only, enforced at the hub.** For an MCP connector, `tools/call` is opaque: scopes and a server's hints aren't
  a guard, and an OAuth grant can be wider than what we use. Each connector has a reviewed allowlist of tool names in
  the repo. The hub denies by default, and a tool the server adds later stays hidden and uncallable until it's
  reviewed and listed.
- **Connector tools on demand:** registered for tool search through P4's runner MCP entry, never always loaded; the
  system prompt names the connected apps.
- **Code mode** at the hub, for Shopify: a Dynamic Worker with no network that reaches the store only through the
  read-only binding, with input and output caps and a timeout, loaded by code hash so a repeated script doesn't create
  a new Worker (S4). An MCP connector gets code mode when its bounded reads stop being enough, not before.
- **Slack as the notification channel:** Slack's hosted MCP server through a registered internal Slack app per brand
  (decision log, "Slack connection"), read-only for the agent.
- **Slack writes go only through our server (Wasim, 2026-11-19):** the approval outbox (P6), or `notification_send`
  to channels the brand's admin listed. `notification_send` takes member ids and listed channels: a member id gets
  the in-app bell (P4), never a Slack DM; a listed channel gets a Slack post. The hub exposes a narrow "post to a
  listed channel" binding to the product Worker only; `notification_send` is its only caller in this phase; the
  channel is checked server-side and every send is audited. The runner never gets Slack write access.
- **What a notice may carry.** The agent writes the text, since an alert has to say what's wrong. The server bounds
  it: link and media unfurls off (Slack fetches URLs in a message, which is a way to send data out), every URL but the
  app's own removed, mentions escaped, a length cap, a cap per run and per day. An admin can't list a channel shared
  with another organisation.
- **From Act.** Slack delivery follows the server's stage: at Watch a notice reaches the bell only (decision log,
  "urgent alerts go to Slack from Act").
- **The Tools page real:** connect, pause and disconnect for the Inhouse team; admins read-only (decision log, "Roles:
  admin views"). A paused tool is hidden from the agent.
- Nightly connector tests with the official servers' test modes.

Out: tool writes other than notification delivery (P6, through the outbox); Slack DMs; connectors for tools without an
official MCP server (built at onboarding, BD4); a public Slack Marketplace app (later, per the decision log).

## Inputs and gates

- P4's hub core is on `fleet/watch` (since wave 2) and `main` with P3 has merged into it; this branch is cut from
  there at the start of wave 4. **The stack is the one approved exception to cutting from `main`.** Its final PR
  follows P4's.
- **The S4 Slack record is final** (done 2026-11-19, [S4](../decisions/p0-s4-connector-hub.md)). Its results are
  inputs to W1 and W4: the hub runs Slack's OAuth itself (no dynamic registration) with a one-time `state` and checks
  the workspace; the token sits AES-GCM encrypted in a Durable Object; with token rotation on, the refresh saves the
  new pair atomically. Slack's 13 write tools appear only with a per-run grant the server sets and the model can't, and
  that grant goes only to the outbox and `notification_send` path, never the runner (Wasim, 2026-11-19). Each brand's
  app gets the 5 least scopes (`search:read.public`, `channels:read`, `channels:history`, `users:read`,
  `chat:write`), so the agent reads public channels only and whose identity it reads as doesn't widen what it sees.
  The hub lists only the tools the brand allows (the full list costs 13K to 99K input tokens a question), and
  private-channel search is a per-brand hub policy. Still open from S4, checked by W1: whether Slack hides a tool
  whose scope is missing or lists it and fails the call.
- **Slack is also the first read tool** for the "ask across it and Shopify" slice: S4 proved its reads behind the hub,
  and the decision log makes the connection read-only for the agent. Search ANDs keywords, so W1 adds a better tool
  description or a hub fallback (retry single keywords, or read the brand's listed channels), and S4's supplier-delay
  case is rerun on Sonnet 5.5 at medium before any engineering change and joins the eval set. **Wasim's decision:**
  whether a second official MCP tool joins P5 now (recommended: no, add it at the first brand that uses one).
- A test workspace for that tool and the Slack test workspace from P0, with apps registered by Wasim.
- **Before W2 starts:** Dynamic Workers availability and pricing read from the current docs; a paid add-on waits for
  Wasim. **If it's unavailable or not approved, code mode is deferred, not passed:** W2 doesn't run, S3 below and
  acceptance 5 switch to P4's bounded reads (a question over the whole order list is answered by paging within the
  bounds), and the decision is recorded in `docs/decisions/`.
- **Test model (Wasim, 2026-11-19):** every test, eval, smoke or check in this phase that calls a real model runs on
  Sonnet 5.5 (`claude-sonnet-5-5`) at medium effort; everything else uses the scripted model.

## Design notes

- **Wave ownership.** `src/agent/mock.ts` and the settings pages belong to P4's W4 in this wave. W3 and W4 here make
  their mock and settings edits only after P4's have merged into `fleet/watch` and `fleet/watch` has merged into this
  branch.
- **Routes.** OAuth and code mode add route files under their own directories, loaded by H0's registry. Product Worker
  routes go through `app/server/routes.ts` (orchestrator).
- **Test path.** The PR gates, the QA gate and the ship recording run on the test build under `wrangler dev` with the
  hub, the scripted model and two fake upstreams under `app/test/upstreams/`: an OAuth MCP server (it also exposes a
  write tool and adds a new tool mid-test, to prove the allowlist) and Slack. No live third-party login screen is
  driven and no tool token is in CI. The official servers' test modes run in the nightly on the house deployment and
  in the orchestrator's live check before the ship packet.
- **The stacked branch.** Just before P4's squash merge, P4's final head merges into this branch; after the squash,
  `main` merges in. The orchestrator then checks the PR's diff against `main` holds only P5's work and runs the ship
  gate again on that head.
- Every migration PR adds its table registry entry (`app/ops/tables/<resource>.ts`).

## Workers

The orchestrator (Opus) writes the design into the brief of every sensitive worker (W1, W2, W4).

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| W1 | opus-worker (Opus 5.5, medium), sensitive: auth | OAuth for official MCP servers at the hub: pre-registered and dynamic clients, connect start, the callback exchange, PKCE, one-use state bound to the member and connector account and re-checked at the callback, refresh (serialised in the `SignIn` object, so a refresh racing a disconnect can't bring a token back), revoke, error states; the per-connector tool allowlist with default deny; tool registration for tool search; the fake OAuth MCP server; the connector account migration. | `app/hub/oauth/**`, `app/hub/connectors/mcp/**`, `app/server/api/connect.ts`, `app/test/upstreams/mcp/**`, migrations in `0300`-`0399` for its tables | branch cut; H1 on this branch for the registration |
| W2 | opus-worker (Opus 5.5, medium), sensitive: sandbox | Code mode for Shopify: the Dynamic Worker loader keyed by code hash, no network, the read-only binding, caps and timeouts, the code-mode tool definition; measured on the recorded full order list as in S4. | `app/hub/codemode/**` | branch cut; the cost check |
| W3 | sonnet-worker (Sonnet 5.5, medium) | The Tools page and its contract on the mock, client and server: connected tools, connect, pause, disconnect, read-only for admins; the composer's tool chips from real data. | `app/server/api/tools.ts`, `app/shared/contract/tools.ts`, `src/agent/http/tools.ts`, `src/screens/Tools.tsx`, `src/components/Composer.tsx` (tool chips); its mock edits after P4's | branch cut |
| W4 | opus-worker (Opus 5.5, medium), sensitive: exfiltration guard | Slack delivery: `notification_send` (member ids to the bell, listed channels to Slack from Act), the text bounds (unfurls off, URLs, mentions, length, the per-run and per-day caps), the narrow delivery binding at the hub, the channel list with shared channels refused, audit lines, the Settings notifications section and its client; the fake Slack upstream; the channel list migration. | `app/server/notify-slack/**`, `app/server/mcp/tools/notifications/**`, `app/hub/connectors/slack/**`, `app/shared/contract/notify-slack.ts`, `src/agent/http/notifications.ts`, `app/test/upstreams/slack/**`, migrations in `0300`-`0399` for its tables; its settings edits after P4's | W1 |
| W5 | sonnet-worker (Sonnet 5.5, medium) | Nightly connector test scripts with the official test modes; API specs for the connect, revoke, tools and notification routes (a wrong, reused or other member's state; a refresh racing a disconnect; an unlisted or newly added MCP tool; a write tool on the fake server); the contract suite's real target for P5 methods; the canary-token test (seed a canary at the hub, run a connect and a code-mode ask, assert it's absent from Worker logs, egress logs, the runner's environment and the transcript); injection cases for the notice bounds. | `app/test/connectors/mcp/**`, `app/e2e/api/{connect,tools,notify-slack}.spec.ts`, `src/agent/contract/targets/real/connectors.ts`, `app/evals/exfiltration/notices/**` | W1 to W4 |

## Orchestrator only

`app/wrangler.hub.jsonc`, `app/wrangler.product.jsonc`, `app/server/routes.ts`, `app/server/access-matrix.ts`,
`app/server/mcp/registry.ts`, `app/ops/tables/index.ts`, `src/agent/http/index.ts`, `app/server/prompt/**` (connected
apps named in the prompt, with eval results), lockfiles, `app/shared/contract/index.ts`, `ci.yml`,
`app/scripts/check-product-build.mjs` (the fake upstreams' canaries), the nightly workflow's connector step (bootstrap
PR into `main`), the live check, `AGENTS.md`, `verify` skill, feature map, `e2e/ship/connectors.spec.ts`.

## Order and parallelism

1. Branch cut from `fleet/watch` at the start of wave 4.
2. W1, W2 and W3 in parallel (W2 only if the cost check passes); W4 after W1; W5 last.
3. At most 3 workers at once (P4 runs beside this phase with 4).
4. P4's final head merges in just before its squash; then `main`; then this phase's diff check, ship gate and final
   PR. If an outside input is late (the cost answer, a second tool if Wasim adds one), the tail carries into wave 5
   with one worker, and P6 doesn't wait for it.

## Browser scenarios (`e2e/ship/connectors.spec.ts`, desktop and phone, test build with the hub and the fake upstreams)

- S1: As the Inhouse team, connect Slack with the pre-consented test user; Tools shows it connected.
- S2: Ask a question that needs Slack and Shopify (a supplier delay and the orders it holds up); the answer cites
  both.
- S3: Ask over the whole order list; the answer comes from a code-mode script and stays short. (If code mode is
  deferred: the answer comes from bounded, paged reads and says how many orders it covered.)
- S4: At Act, an alert reaches a listed Slack channel with no link preview; a channel that isn't listed is refused
  with a clear message. At Watch the same alert reaches the bell only.
- S5: Pause the tool; the agent no longer uses it; unpause.
- S6: Disconnect the tool; asking again says it's not connected and offers what's connected.
- S7: As an admin, Tools is read-only.

## Acceptance

1. OAuth connect, refresh and revoke work against the fake server in CI and against Slack's hosted
   server through its pre-registered app in the nightly; a callback with a wrong, reused or another member's state is refused; a
   refresh racing a disconnect leaves no token; no token crosses from the hub to the product Worker.
2. An MCP tool outside its connector's allowlist is hidden and refused at the hub, a write tool on the fake server
   included; a tool the server adds stays hidden until it's listed.
3. The canary-token test passes: no connector token in the product Worker, the container, any log or a transcript.
4. Connector tools load on demand only; the system prompt names exactly the connected apps; a paused tool is hidden.
5. Code mode has no network (a fetch from a script fails), reaches only its read-only binding, loads by code hash, and
   its output stays under the cap; the S4 measurement repeats within range. If code mode is deferred, this item is
   recorded as deferred with its decision record, not as passed.
6. `notification_send` posts to Slack only for listed channels and only from Act; a member id reaches the bell and
   never a DM; an unlisted channel, a shared channel, a user mentioned inside the text and a send past the caps are
   refused or neutralised and audited; a posted notice has unfurls off and no outside URL; the delivery binding isn't
   reachable from the runner, and a Slack write attempted from the runner's scope is refused at the hub.
7. The agent's Slack reads cover public channels only (the scope list is asserted).
8. The Tools page is read-only for admins and works for the Inhouse team.
9. Nightly connector tests and API specs pass; the contract suite passes for P5 methods.
10. After P4's squash, this PR's diff against `main` holds only P5's work, and the ship gate ran on that head.
11. QA PASS and the ship recording on S1 to S7; after the release, the real-model smoke passes on the house deployment.

## Must not

No hosted Executor and no third party holding brand keys; no connector write except Slack delivery to listed channels
through our server; no Slack DM; no Slack write access for the runner; no delivery binding reachable from the runner;
no MCP tool callable without a reviewed allowlist entry; no link preview or outside URL in a notice; no Dynamic Worker
with network access; no paid add-on without Wasim's OK; no real brand workspace in tests; no live third-party login in
the ship recording; no tool token in CI.

## Risks

- Official MCP servers change their auth and their tools; nightly tests catch it, each connector pins its server
  version where it can, and the allowlist means a new tool is never live by surprise.
- Dynamic Workers may be beta or paid; the cost check before W2, with P4's bounded reads as the recorded fallback.
- Slack needs a registered app per brand; P8's onboarding checklist covers it.
- One outside input still gates part of this phase (the Dynamic Workers cost answer); the Slack record is done, and a
  late input delays only this phase's tail.

## How it lands

- Branch `fleet/connectors` from `fleet/watch` at the start of wave 4; its final PR into `main` after P4's.
- Review rows: W1, W2, W4 and every migration at Sonnet plus Opus high (auth, sandbox, exfiltration, schema); W3, W5
  Sonnet plus Opus medium.
- Final PR with the full ship gate; the house release and real-model smoke follow, with Wasim's OK.
