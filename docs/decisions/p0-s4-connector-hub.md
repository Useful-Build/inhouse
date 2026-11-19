# P0 S4: connector hub

Date: 2026-11-19. **Status: final, Slack pending.** The Slack part (an official MCP server with OAuth) runs next.
Backend plan open test 6. Plan: `docs/plans/2026-11-19-backend.md`.

## Decision

Our own gateway Worker is the connector hub (decided 2026-11-19, confirmed by this spike). Self-hosted Executor was not
deployed.

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

## Still to do

Slack over OAuth through the hub: an internal Slack app with the MCP server on, user token scopes, confidential OAuth
(no dynamic client registration), one consent, a test channel. Token expiry and rotation are checked in that run.

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
- https://docs.slack.dev/ai/slack-mcp-server/ and its developing and harness pages
- Executor's self-host, MCP, approvals and API key docs in its public repo
