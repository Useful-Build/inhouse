# P0 S4: connector hub (interim)

Date: 2026-11-19. **Status: interim.** S4 is still running; the order-list run and a live Executor test are pending.
Backend plan open test 6. Plan: `docs/plans/2026-11-19-backend.md`.

## Decision

Our own gateway Worker is the connector hub (decided 2026-11-19). Self-hosted Executor is not deployed.

## What was tested so far

- Our gateway Worker on the house account: it holds a Shopify sign-in, refreshes it, enforces read-only scope, serves
  MCP and runs code mode, against a dev store seeded with 150 products.
- A runner stand-in (Haiku 5.5) asking a question through the gateway.
- Self-hosted Executor, from its docs and repo (config written, not deployed).

## Results so far

- **Client credentials grant:** 24 h tokens, grant round trip 332 ms, scopes returned exactly as configured.
- **Read-only, two layers:** a mutation through the gateway is refused by our GraphQL parse check (403); the same
  mutation sent straight to Shopify with the read app's token gets `ACCESS_DENIED`.
- **Sign-in outside the container:** the token lives only in the gateway's Durable Object, AES-GCM encrypted under a
  versioned key, refreshed by alarm before expiry and once on a 401. Code-mode scripts get an RPC binding, never the
  token.
- **Code mode** (Dynamic Workers, `globalOutbound: null`): one script paged all 150 products; 497 characters reached the
  model; 7.4 s; $0.00078.
- **Protected customer data:** without it, both apps were refused the Order object. Level 1 (no names, emails, phones or
  addresses) is enough for Watch.
- **Dev store limits:** GraphQL bucket 2,000 points, restoring 100 a second; dev stores take 5 new orders a minute.
- **Build effort:** about 1 hour for about 230 lines. Upkeep: the quarterly Shopify API version and two dependencies.

## Why not self-hosted Executor

- Its image is on ghcr.io, which Cloudflare Containers can't pull from, and its database and keys live on a disk that
  Containers wipe on every stop or deploy.
- A runner holding its token picks the approval mode per request, so it could approve its own call (from its docs; not
  tested live).
- Still beta, with several releases a day.

## What it changes in the plan

- Architecture 6: the hub is our gateway Worker.
- Shopify (P4, P5, readiness): Dev Dashboard apps with the client credentials grant; each brand's app declares level 1
  protected customer data, level 2 only if a feature needs names or addresses.
- Seeding a dev store's orders is slow (5 a minute); plan seed time for it.

## Still to do

Seed orders, measure the order limit, run the order-list code-mode script, Slack over OAuth, final record.

## Docs read (2026-11-19)

- https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCreate
- https://shopify.dev/docs/apps/launch/protected-customer-data
- https://developers.cloudflare.com/containers/platform-details/
- https://developers.cloudflare.com/containers/platform-details/image-management/
- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/dynamic-workers/getting-started/
- https://developers.cloudflare.com/dynamic-workers/pricing/
- Executor's self-host, MCP, approvals and API key docs in its public repo
