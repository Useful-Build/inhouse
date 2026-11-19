# P5: connectors (`fleet/connectors`)

Status: draft, 2026-11-19, revised after the Sonnet and Opus review. Phase plan under the backend plan
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
  the code; no token crosses back.
- **Connector tools on demand:** registered for tool search through H0's runner MCP entry, never always loaded; the
  system prompt names the connected apps.
- **Code mode** at the hub: a Dynamic Worker with no network that reaches the tool only through a read-only binding,
  with input and output caps and a timeout; available for Shopify and the MCP connectors.
- **Slack as the notification channel:** Slack's hosted MCP server through a registered internal Slack app per brand
  (decision log, "Slack connection"). `notification_send` resolves recipients only from member ids and the Slack
  channels an admin listed. A member's Slack user is a stored mapping, filled by a one-time lookup by the member's email
  (the scope it needs is checked against Slack's docs) and editable by an admin.
- **Slack writes go only through our server (Wasim, 2026-11-19):** the approval outbox (P6), or `notification_send`
  to admin-listed channels and member ids. The hub exposes a narrow "post to a listed channel or member" binding to
  the product Worker only; `notification_send` is its only caller in this phase; recipients are checked server-side
  and every send is audited. The runner never gets Slack write access: its Slack scope, like every connector's, is read
  only.
- **The Tools page real:** connect, pause and disconnect for the Inhouse team; admins read-only (decision log, "Roles:
  admin views"). A paused tool is hidden from the agent.
- Nightly connector tests with the official servers' test modes.

Out: tool writes other than notification delivery (P6, through the outbox); connectors for tools without an official
MCP server (built at onboarding, BD4); a public Slack Marketplace app (later, per the decision log).

## Inputs and gates

- P4's hub core (H0) merged into `fleet/watch`; this branch is cut from there and its final PR follows P4's.
- **The S4 Slack record is final** (OAuth, token expiry and rotation, scopes), and any change it makes to this plan went
  to Wasim. W1 doesn't start before it.
- **Wasim's decisions:** which official MCP read tool P5 connects first for the "ask across it and Shopify" slice
  (Slack is a channel, not a read tool, per the decision log; recommended: the tool most of the first brands use that
  has an official MCP server with a test mode).
- A test workspace for that tool and the Slack test workspace from P0, with apps registered by Wasim.
- **Before W2 starts:** Dynamic Workers availability and pricing read from the current docs; a paid add-on waits for
  Wasim. Fallback: P4's bounded reads only.
- **Test model (Wasim, 2026-11-19):** every test, eval, smoke or check in this phase that calls a real model runs on
  Sonnet 5.5 (`claude-sonnet-5-5`) at medium effort; everything else uses the scripted model.

## Design notes

- **Wave ownership.** `src/agent/mock.ts` and the settings pages belong to P4's W4 in this wave. W3 and W4 here make
  their mock and settings edits only after P4's have merged into `fleet/watch` and `fleet/watch` has merged into this
  branch.
- **Routes.** OAuth and code mode add route files under their own directories, loaded by H0's registry. Product Worker
  routes go through `app/server/routes.ts` (orchestrator).
- **Test path.** The QA gate and ship recording run on the test build under `wrangler dev` with the hub, the scripted
  model and the chosen tool's test mode, with a test user already consented so no live third-party login screen is
  driven.

## Workers

The orchestrator (Opus) writes the design into the brief of every sensitive worker (W1, W2, W4).

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| W1 | opus-worker (Opus 5.5, medium), sensitive: auth | OAuth for official MCP servers at the hub: pre-registered and dynamic clients, connect start, the callback exchange, PKCE, state bound to the member and connector account, refresh, revoke, error states; tool registration for tool search; the connector account migration. | `app/hub/oauth/**`, `app/hub/connectors/mcp/**`, `app/server/api/connect.ts`, migrations in `0300`-`0399` for its tables | branch cut; the S4 Slack record |
| W2 | opus-worker (Opus 5.5, medium), sensitive: sandbox | Code mode: the Dynamic Worker loader, no network, the read-only binding per tool, caps and timeouts, the code-mode tool definition; measured on the read fixture's full order list as in S4. | `app/hub/codemode/**` | branch cut; the cost check |
| W3 | sonnet-worker (Sonnet 5.5, medium) | The Tools page and its contract on the mock, client and server: connected tools, connect, pause, disconnect, read-only for admins; the composer's tool chips from real data. | `app/server/api/tools.ts`, `app/shared/contract/tools.ts`, `src/agent/http/tools.ts`, `src/screens/Tools.tsx`, `src/components/Composer.tsx` (tool chips); its mock edits after P4's | branch cut |
| W4 | opus-worker (Opus 5.5, medium), sensitive: exfiltration guard | Slack delivery: `notification_send` with recipients only from member ids and listed channels, the member-to-Slack mapping, the narrow delivery binding at the hub, audit lines, the Settings notifications section and the channel list; the mapping migration. | `app/server/notify-slack/**`, `app/server/mcp/tools/notifications/**`, `app/hub/connectors/slack/**`, `app/shared/contract/notify-slack.ts`, migrations in `0300`-`0399` for its tables; its settings edits after P4's | W1 |
| W5 | sonnet-worker (Sonnet 5.5, medium) | Nightly connector test scripts with the official test modes; API specs for the connect, revoke, tools and notification routes; the contract suite's real target for P5 methods; the canary-token test (seed a canary at the hub, run a connect and a code-mode ask, assert it's absent from Worker logs, egress logs, the runner's environment and the transcript). | `app/test/connectors/mcp/**`, `app/e2e/api/{connect,tools,notify-slack}.spec.ts`, `src/agent/contract/targets/real.ts` (P5 additions) | W1 to W4 |

## Orchestrator only

`app/wrangler.hub.jsonc`, `app/wrangler.product.jsonc`, `app/server/routes.ts`, `app/server/mcp/registry.ts`,
`app/server/prompt/**` (connected apps named in the prompt, with eval results), lockfiles,
`app/shared/contract/index.ts`, `ci.yml`, the nightly workflow's connector step (bootstrap PR into `main`),
`AGENTS.md`, `verify` skill, feature map, `e2e/ship/connectors.spec.ts`.

## Order and parallelism

1. Branch cut from `fleet/watch` once H0 merges there.
2. W2 and W3 in parallel; W1 once the S4 Slack record is final; W4 after W1; W5 last.
3. At most 4 workers at once (P4 runs beside this phase).
4. When P4 merges into `main`, `main` merges into this branch; then its final PR.

## Browser scenarios (`e2e/ship/connectors.spec.ts`, desktop and phone, test build with the hub and the tool's test mode)

- S1: As the Inhouse team, connect the chosen tool with the pre-consented test user; Tools shows it connected.
- S2: Ask a question that needs the tool and Shopify; the answer cites both.
- S3: Ask over the whole order list; the answer comes from a code-mode script and stays short.
- S4: An admin sends an alert to a listed Slack channel; a channel that isn't listed is refused with a clear message.
- S5: Pause the tool; the agent no longer uses it; unpause.
- S6: Disconnect the tool; asking again says it's not connected and offers what's connected.
- S7: As an admin, Tools is read-only.

## Acceptance

1. OAuth connect, refresh and revoke work against the chosen server's test mode and Slack's pre-registered app; a
   callback with a wrong or reused state is refused; no token crosses from the hub to the product Worker.
2. The canary-token test passes: no connector token in the product Worker, the container, any log or a transcript.
3. Connector tools load on demand only; the system prompt names exactly the connected apps; a paused tool is hidden.
4. Code mode has no network (a fetch from a script fails), reaches only its read-only binding, and its output stays
   under the cap; the S4 measurement repeats within range.
5. `notification_send` reaches only member ids and listed channels; a member's email that isn't a member id, a user
   mentioned inside the text and an unlisted channel are all refused and audited; the delivery binding isn't reachable
   from the runner, and a Slack write attempted from the runner's scope is refused at the hub.
6. The Tools page is read-only for admins and works for the Inhouse team.
7. Nightly connector tests and API specs pass; the contract suite passes for P5 methods.
8. QA PASS and the ship recording on S1 to S7; the real-model smoke passes on the house deployment.

## Must not

No hosted Executor and no third party holding brand keys; no connector write except Slack delivery to the listed set
through our server; no Slack write access for the runner; no delivery binding reachable from the runner; no recipient outside the listed set; no Dynamic Worker with
network access; no paid add-on without Wasim's OK; no real brand workspace in tests; no live third-party login in the
ship recording.

## Risks

- Official MCP servers change their auth; nightly tests catch it, and each connector pins its server version where it
  can.
- Dynamic Workers may be beta or paid; the cost check before W2, with P4's bounded reads as the fallback.
- Slack needs a registered app per brand; P8's onboarding checklist covers it.

## How it lands

- Branch `fleet/connectors` from `fleet/watch` after H0; its final PR into `main` after P4's.
- Review rows: W1, W2, W4 and every migration at Sonnet plus Opus high (auth, sandbox, exfiltration, schema); W3, W5
  Sonnet plus Opus medium.
- Final PR with the full ship gate; the house release and real-model smoke follow, with Wasim's OK.
