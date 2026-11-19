# P5: connectors (`fleet/connectors`)

Status: draft, 2026-11-19. Phase plan under the backend plan (`docs/plans/2026-11-19-backend.md`). Common rules are in
its "Phase schedule (waves)" section. P0 record: [S4](../decisions/p0-s4-connector-hub.md).

## Goal

Connect tools that publish an official MCP server through the hub, let the agent reach large results through code
mode, and make Slack the notification channel.

**Success measure (the real slice):** connect one official MCP tool and ask across it and Shopify.

## Scope

In:
- **OAuth at the hub** for official MCP servers, with the MCP TypeScript SDK's client auth (S4 confirmed the fit):
  connect, refresh, revoke, PKCE and state checks, one `SignIn` object per connector account, tokens encrypted with
  H0's key.
- **Connector tools on demand:** registered for tool search, never always loaded; the system prompt names the
  connected apps.
- **Code mode** at the hub: a Dynamic Worker with no network that reaches the tool only through a read-only binding,
  with output caps; available for Shopify and the MCP connectors.
- **Slack as the notification channel:** Slack's hosted MCP server through a registered internal Slack app per brand
  (decision log, "Slack connection"); `notification_send` resolves recipients from member ids and the Slack channels
  an admin listed, nothing else; the Settings notifications page real.
- **The Tools page real:** connect, pause and disconnect for the Inhouse team; admins read-only (decision log, "Roles:
  admin views").
- Nightly connector tests with the official servers' test modes.

Out: tool writes (P6, through the outbox); connectors for tools without an official MCP server (built at onboarding,
BD4); a public Slack Marketplace app (later, per the decision log).

## Inputs and gates

- P4's hub core (H0) merged into `fleet/watch`; this branch is cut from there (see the schedule) and its final PR
  follows P4's.
- **Wasim's decision:** which official MCP read tool P5 connects first for the "ask across it and Shopify" slice
  (Slack is a channel, not a read tool, per the decision log). Recommendation: the tool most of the first brands use
  that has an official MCP server with a test mode.
- A test workspace for that tool and the Slack test workspace from P0 (exists), with apps registered by Wasim.
- **Cost check before W2 merges:** Dynamic Workers pricing read from the current docs; a paid add-on waits for Wasim.

## Workers

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| W1 | opus-worker (Opus 5.5, medium), sensitive: auth | OAuth for official MCP servers at the hub: the connect start and callback routes, PKCE, state bound to the member and connector account, refresh, revoke, error states; tool registration for tool search. | `app/hub/oauth/**`, `app/hub/connectors/mcp/**` | branch cut |
| W2 | opus-worker (Opus 5.5, medium), sensitive: sandbox | Code mode: the Dynamic Worker loader, no network, the read-only binding per tool, input and output caps, timeouts, the code-mode tool definition; measured on the fixture store's full order list as in S4. | `app/hub/codemode/**` | branch cut |
| W3 | sonnet-worker (Sonnet 5.5, medium) | The Tools page and its contract on the mock and server: connected tools, connect, pause, disconnect, read-only for admins; the composer's tool chips from real data. | `app/server/api/tools.ts`, `src/screens/Tools.tsx`, `src/components/Composer.tsx` (tool chips), `src/agent/mock.ts` | branch cut |
| W4 | sonnet-worker (Sonnet 5.5, medium) | Slack: `notification_send` with recipients only from member ids and listed channels, delivery through the hub's Slack connection, the Settings notifications page and the channel list. | `app/server/notify/**`, `app/server/mcp/tools/notifications.ts`, `src/screens/settings/notifications*` | W1 |
| W5 | sonnet-worker (Sonnet 5.5, medium) | Nightly connector tests with the official test modes; API specs for the connect, revoke and notification routes; the contract suite's real target for P5 methods. | `app/test/connectors/mcp/**`, `app/e2e/api/{tools,notifications}.spec.ts` | W1 to W4 |

## Orchestrator only

`app/wrangler.hub.jsonc`, `app/wrangler.product.jsonc`, migrations `0300`-`0399`, `app/server/routes.ts`,
`app/server/prompt/**` (connected apps named in the prompt, with eval results), lockfiles,
`app/shared/contract/index.ts`, `ci.yml`, the nightly workflow's connector step, `AGENTS.md`, `verify` skill, feature
map, `e2e/ship/connectors.spec.ts`.

## Order and parallelism

1. Branch cut from `fleet/watch` once H0 merges there.
2. W1, W2, W3 in parallel; W4 after W1; W5 last.
3. At most 4 workers at once (P4 runs beside this phase).
4. When P4 merges into `main`, `main` merges into this branch; then its final PR.

## Browser scenarios (`e2e/ship/connectors.spec.ts`, desktop and phone)

- S1: As the Inhouse team, connect the chosen tool in its test workspace; Tools shows it connected.
- S2: Ask a question that needs the tool and Shopify; the answer cites both.
- S3: Ask over the whole order list; the answer comes from a code-mode script and stays short.
- S4: An admin sends an alert to a listed Slack channel; a channel that isn't listed is refused with a clear message.
- S5: Disconnect the tool; asking again says it's not connected and offers what's connected.
- S6: As an admin, Tools is read-only.

## Acceptance

1. OAuth connect, refresh and revoke work against the chosen server's test mode; a callback with a wrong or reused
   state is refused.
2. No connector token reaches the product Worker, the container or a log.
3. Connector tools load on demand only; the system prompt names exactly the connected apps.
4. Code mode has no network (a fetch from a script fails), reaches only its read-only binding, and its output stays
   under the cap; the S4 measurement repeats within range.
5. `notification_send` reaches only member ids and listed channels; any other recipient is refused and audited.
6. The Tools page is read-only for admins and works for the Inhouse team.
7. Nightly connector tests and API specs pass; the contract suite passes for P5 methods.
8. QA PASS and the ship recording on S1 to S6.

## Must not

No hosted Executor and no third party holding brand keys; no write through a connector; no recipient outside the
listed set; no Dynamic Worker with network access; no paid add-on without Wasim's OK; no real brand workspace in tests.

## Risks

- Official MCP servers change their auth; nightly tests catch it, and each connector pins its server version where it
  can.
- Dynamic Workers may be beta or paid; the cost check above, and a fallback of plain bounded reads (P4) if it can't be
  used.
- Slack needs a registered app per brand; onboarding (P8 checklist) covers it.

## How it lands

- Branch `fleet/connectors` from `fleet/watch` after H0; its final PR into `main` after P4's.
- Review rows: W1 and W2 at Sonnet plus Opus high (auth, sandbox); W3 to W5 Sonnet plus Opus medium.
- Final PR with the full ship gate; release to the house deployment with Wasim's OK.
