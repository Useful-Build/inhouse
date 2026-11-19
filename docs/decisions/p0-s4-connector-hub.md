# P0 S4: connector hub

Date: 2026-11-19. **Status: final.** Slack included.
Backend plan open test 6. Plan: `docs/plans/2026-11-19-backend.md`.

## Decision

Our own gateway Worker is the connector hub (decided 2026-11-19, confirmed by this spike). Self-hosted Executor was not
deployed. Slack's own hosted MCP server runs behind the gateway, with OAuth held by the hub.

## What was tested

- A dev store seeded by a throwaway Worker: 150 products, one location, tracked inventory, and 300 orders over 90
  days with no customers attached (so no level 2 fields). The orders plant the cases Watch must find: an unfulfilled
  paid order, a refund spike on one product, open returns not restocked, a product about to run out, an oversold one.
- Our gateway Worker on the house account: it holds a Shopify sign-in, refreshes it, enforces read-only scope, serves
  MCP and runs code mode.
- A runner stand-in (Haiku 5.5, default effort) asking four Watch questions through the gateway.
- Self-hosted Executor, from its docs and repo (config written, never deployed).

## Results

**Seeding.**
- 300 orders in 69 minutes: a median of **5 orders a minute** (7 at most in one minute), as the docs say. A burst of 5
  goes through, then the limit applies, as a userError (`Too many attempts`), not a GraphQL throttle.
- GraphQL bucket 2,000 points, restoring 100 a second; never throttled. Product creation took about 4 s a call.
- **Shopify won't backdate refunds:** `processedAt` on `refundCreate` is ignored, so every refund is dated when it was
  made. Orders do backdate. Test data that needs dated refunds must create them on that day.
- A token kept in isolate memory was fetched 211 times (alarms often land on a fresh isolate). The gateway keeps its
  token in Durable Object storage and fetched it once in about 2 hours, across two redeploys.

**Our gateway.**
- **Client credentials grant:** 24 h tokens, grant round trip 332 ms, scopes returned exactly as configured.
- **Sign-in outside the container:** the token lives only in a `SignIn` Durable Object, AES-GCM encrypted under a
  versioned key, refreshed by alarm before expiry and once on a 401. Code-mode scripts get an RPC binding, never the
  token.
- **Read-only, two layers:** a mutation through the gateway is refused by our GraphQL parse check (403); the same
  mutation sent straight to Shopify with the read app's token gets `ACCESS_DENIED`.
- **Code mode over the full order list** (Dynamic Workers, `globalOutbound: null`, reaching Shopify only through the
  read-only binding). The raw list is about 88K characters (about 25K tokens), fetched in 675 ms. Haiku picked the
  code-mode tool by itself every time:

| Question | Scripts | Reached the model | Time | Cost | Right? |
|---|---|---|---|---|---|
| Lowest-stock products, count over $150 | 1 | 497 chars | 7.4 s | $0.00078 | yes |
| Paid orders unfulfilled over 3 days | 1 | 199 chars | 5.5 s | $0.00064 | yes |
| Refund spike by product and reason | 1 | 231 chars | 8.2 s | $0.00105 | yes |
| Open returns, not restocked | 5 (4 errors) | 1,131 chars | 17.1 s | $0.00354 | yes, by a workaround |

  The returns question hit `Access denied for returns field`: the read app lacked `read_returns`. The model fell back
  to each order's return status and said so.
- **Protected customer data:** without the level 1 declaration, the Order object is refused for reads and for
  `orderCreate`'s return value. Level 1 (no names, emails, phones or addresses) is enough for Watch.
- **Build effort:** about 1.5 hours for about 250 lines, two dependencies (the MCP TypeScript SDK and `graphql`).
  Upkeep: the quarterly Shopify API version, the two dependencies, the code-mode tool description and each app's
  scope list.

## Slack: its hosted MCP server through our gateway

**Result: it fits the gateway design.** About 1 hour and 150 more lines in the gateway.

- **OAuth is ours.** Slack has no dynamic client registration, so the hub runs Slack's user OAuth flow itself (one form
  POST) with a one-time `state` (random, 2 h, deleted on first check). The callback is the only route without a run
  token. The token is stored AES-GCM encrypted under a versioned key in a Durable Object, and the workspace is checked
  against the expected one. The MCP TypeScript SDK's client is used for the proxy only.
- **Read-only by default.** The hub proxies Slack's hosted MCP server behind its own tool list. Slack marks 14 of its
  27 tools as reads and 13 as writes. Without a grant the hub lists only the reads; write tools appear only with a
  per-run grant the server sets and the model can't. A direct write call with no grant is refused by the hub. In
  the product the grant goes only to the server's outbox and `notification_send` path, never to the runner
  (confirmed, Wasim 2026-11-19).
- **Least scopes:** 5 of Slack's 30 cover Watch and notifications in public channels: `search:read.public`,
  `channels:read`, `channels:history`, `users:read` and `chat:write`. Private channel and DM reads are a privacy choice
  per brand. Still to check in P5: whether Slack hides a tool whose scopes are missing or lists it and fails the call.
- **Token rotation.** With rotation off, a user token has no expiry and no refresh token; it lasts until revoked or
  uninstalled. With rotation on, Slack's docs say user tokens last 12 h and refresh tokens are single-use, so the
  holder must save each new pair atomically.

Tests (Haiku 5.5, 7 runs, $0.027 in all):

| Test | Result | Input tokens |
|---|---|---|
| "Mentioned a supplier delay?" | **Missed**, at medium and high effort (6 searches each) | about 42K |
| Same, worded "restock will ship late?" | Found the message (3 searches) | 28K |
| List my channels | Right | 27K |
| Post to a test channel, grant on | Posted | 99K over the turns |
| Post, grant off | No write tool listed, so the model said it can't | 13K |

Findings:
1. **Search ANDs keywords.** The model tried "supplier" with "delay", "vendor", "backorder" and others, while the
   message said "ships 2 weeks late"; searching "supplier" alone finds it. Wording mismatches miss.
2. **The model used private-channel search without asking,** though Slack's tool description says to get consent
   first. Private search must be hub policy per brand, not the model's choice.
3. **Slack's tool list is large:** 13K to 99K input tokens per question.

Decision (Wasim, 2026-11-19): one internal Slack app per brand at first, a Marketplace app later.

**Recheck on Sonnet.** Every model result in this record ran on Haiku 5.5, the Slack search miss included. Tests and
evals that call a real model now run on Sonnet 5.5 at medium (Wasim, 2026-11-19), so P5 reruns these cases on Sonnet
before blaming the engineering (the tool description, the hub or the search fallback).

## Why not self-hosted Executor

- Its image is on ghcr.io, which Cloudflare Containers can't pull from, and its database and keys live on a disk that
  Containers wipe on every stop or deploy. We'd build the persistence layer ourselves.
- A runner holding its token picks the approval mode per request, so it could approve its own call (from its docs; not
  tested live). With read-only credentials its approvals add nothing, and writes still need our outbox.
- Still beta, with several releases a day. A Shopify connector there would be an app we author in its format.

## What it changes in the plan

- Architecture 6 and P5: the hub is our gateway Worker, with a `SignIn` Durable Object per connector account. Tokens
  live in Durable Object storage, never isolate memory.
- Code mode runs at the hub in a Dynamic Worker with no network, not in the container: raw pages never reach the
  container or the model, only the script's return value. Dynamic Workers need Workers Paid in each brand's account;
  load scripts by code hash so each call doesn't create a new worker.
- Each brand's Shopify app: a Dev Dashboard app with the client credentials grant, level 1 protected customer data
  (level 2 only if a feature needs names or addresses), and `read_returns` in its read scopes.
- Test fixture: dev stores take 5 orders a minute, so the nightly connector tests use a seeded store as a fixed
  fixture and never reseed per run. Dated refunds are made on their day.

- Slack (P5): its hosted MCP server behind the hub, read-only by default, writes only with a per-run grant the model
  can't set, given only to the outbox and `notification_send` path (confirmed, Wasim 2026-11-19). P5 reruns the
  Haiku cases on Sonnet 5.5 at medium first. Each brand's app gets the 5 least scopes above. The hub lists only the tools the brand's policy allows
  (Slack's full list costs 13K to 99K input tokens a question), and private-channel search is a per-brand hub policy.
  Search needs a better tool description or a hub fallback (retry single keywords, or read the brand's listed
  channels), and the supplier-delay case joins the eval set. With token rotation on, the refresh path saves the new
  token pair atomically. One internal Slack app per brand at first, a Marketplace app later.

## Docs read (2026-11-19)

- https://shopify.dev/docs/api/admin-graphql/latest/ (`orderCreate`, `refundCreate`, `returnCreate`, `productSet`,
  `inventorySetQuantities` and their inputs)
- https://shopify.dev/docs/apps/launch/protected-customer-data
- https://developers.cloudflare.com/containers/platform-details/
- https://developers.cloudflare.com/containers/platform-details/image-management/
- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/dynamic-workers/getting-started/
- https://developers.cloudflare.com/dynamic-workers/usage/bindings/
- https://developers.cloudflare.com/dynamic-workers/pricing/
- https://developers.cloudflare.com/dynamic-workers/examples/codemode/
- https://docs.slack.dev/ai/slack-mcp-server/ and its developing and harness pages (tools, scope groups, no dynamic
  client registration, internal apps)
- https://docs.slack.dev/authentication/using-token-rotation/
- Executor's self-host, MCP, approvals and API key docs in its public repo
