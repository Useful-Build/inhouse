# Connecting any tool: three paths for the Inhouse team, and what we learn from Executor

Status: **approved by Wasim on 2026-11-26, with every recommendation in section 12 (W1 to W4).** Folded into the
[master plan](2026-11-24-master-plan.md) the same day: D6, sections 1, 4.4, 4.5, 4.9, 6, 12 and 13, M4 and M7.
Section 10 lists those edits.

Research base: Executor's public source at commit `d30f09c` (branch `v2`, release `2.0.0-beta.79`, 2026-11-26) and its
docs, read on 2026-11-26. **Nothing was deployed or run.** Every rule taken from Executor is their description of a
service's behaviour, not something we observed, so each one needs its own fixture test here and live proof in Stage 2.

## 1. In plain words

- **We keep our own hub.** We don't run Executor inside the product. We read its code and take what it learned.
- **The Inhouse team connects a brand's tools.** A tool comes in one of three shapes, and each gets a path:
  1. **It has an MCP address and a sign-in.** Paste the address, sign in once.
  2. **It has an MCP address and an API key** (or needs nothing at all). Paste the address, enter the key once.
  3. **It has no MCP address.** We build a small connector for it.
- **A failed connection says why.** "This tool's login server didn't answer" beats "Connect refused".
- **What we take from Executor is knowledge, not files:** the list of ways real services break the sign-in standard,
  the rules for when a login is really dead, how to tell which path a tool needs, and their test scenarios. We write
  it in our own code, with our own tests.

## 2. Goal

The Inhouse team can connect any tool a brand uses, in one sitting, whichever shape it comes in, and the hub handles
the sign-in quirks of real services without signing a brand out by mistake.

**Success measure:** on the test build, four fixture tools (one with no sign-in, one with a sign-in, one with an API
key, one with no MCP address served by a built connector) each go from a pasted address to a working read in chat with
no change to hub code, and each of the 12 planted sign-in faults in section 6.3 gives its expected outcome.

## 3. Decision: learn from Executor, don't run it

Wasim asked on 2026-11-26 whether self-hosted [Executor](https://executor.sh) should replace `app/hub/`. The earlier
"no" ([P0 S4](../decisions/p0-s4-connector-hub.md), 2026-11-19) was a short read of its docs. This is the fuller check.

**It would not fit today, for four reasons:**

1. **It can't live in the brand's Cloudflare account.** v2 self-host is one Docker container with its database and
   keys on a disk volume, one replica, one organization per instance. Cloudflare Containers have no persistent disk
   (snapshots are in beta), and v2 has no Cloudflare self-host (v1 did). So it would be one container and volume per
   brand on another cloud, which cuts against "installed in the brand's own accounts".
2. **Its upstream client can't reach a new-only MCP server.** It calls remote servers with
   `@modelcontextprotocol/sdk` 1.32.1, whose newest protocol is 2025-11-25 (checked in the published package). M4 must
   reach 2026-07-28 servers.
3. **It trusts the server's own labels.** "Read-only" is the server's `readOnlyHint`, new tools appear without review
   and there's no definition pinning. Our plan treats those labels as hints, never authority (D3, section 4.4).
4. **It's a fast-moving beta from one person.** 12 releases from 2026-11-22 to 2026-11-25, 1,313 of the 1,367
   commits on `v2` by one author, 159 open issues and 58 open pull requests, and v1 to v2 had no in-place data
   migration.

**What we'd still have had to build:** all of M2 and M3 (its approvals have no limits, hold, Undo, batch cards or
remembered grants), the drift guard, the leak guard, our own connect screen, and per-brand container upkeep.

**One correction to the 2026-11-19 record:** the worry that a runner can approve its own call is mostly fixed in v2.
The approval mode is kept in the sign-in grant, and a scoped connection can be read-only.

**Re-check when all three are true:** v2 is out of beta, its upstream client speaks 2026-07-28, and it has a
Cloudflare-native self-host.

## 4. Who connects a tool

**Wasim, 2026-11-26:** the product is mostly run by us. The Inhouse team connects each brand's tools, whether that
takes a sign-in, an API key or a connector we build.

**What's there today (checked on `main` at `2673a87f`):** this already matches the code. Starting a connection, its
callback, pausing and disconnecting are allowed only for the `inhouse` role (`app/server/access-matrix.ts`, rows 68,
69, 71 and 72). Members and Admins read the Tools page and use **Request a tool** (`FEATURE_MAP.md`, "Tools: list and
pages").

**The split this plan proposes:**

| Step | Who | Where |
|---|---|---|
| Ask for a tool | Member or Admin | Tools page, Request a tool (exists) |
| Work out the path, set up the connection, review the tool list | Inhouse team | Tools page |
| Give the login once (sign in, or enter a key) | Whoever holds it: the Inhouse team, or the brand's Admin on a connection we prepared | Tools page, never chat or email |
| See what's connected and who did it | Everyone (list), Admin (audit) | Tools page, Activity |

**Decided (W1, 2026-11-26):** a brand's Admin may do the credential step on a connection the Inhouse team prepared.
They usually hold the tool's login, and a key sent over Slack or email is the path we most want to avoid.

## 5. The connection ladder

One flow, the same for every tool. The hub works out the path; the person doesn't have to know it in advance.

### Step 0: detect

From a pasted address, the hub asks the server a few questions **without credentials** and reports one outcome:

| Outcome | What it means | Next |
|---|---|---|
| Works with no sign-in | The server answers and lists tools for anyone | Review the tools (step 4) |
| Needs a sign-in, and we can get our own client | The login server takes our client ID document, or lets us register | Path A |
| Needs a sign-in, and wants an app registered first | Google, GitHub and Slack offer no registration (Executor's guide) | Path A with a registered app |
| Needs a key | It refuses anonymous use and offers no usable sign-in | Path B |
| Blocked | A firewall or web page answered, not the tool | Say so; don't ask for a login |
| No MCP address at all | The tool has an API but no MCP server | Path C |

The detection order is Executor's (section 6.1). Our probe differs: it tries the 2026-07-28 `server/discover` call
first and falls back to `initialize` (master plan 4.5). Detection never follows a redirect, sends a credential or calls
a tool.

### Path A: sign in

The M4 sign-in upgrade (master plan 4.5, item 5), plus three things from Executor:

- **Where the client comes from, in order:** a client already saved for this server, our client ID document, dynamic
  registration, then an app the Inhouse team registers in the service's developer settings. If a server advertises
  registration and then refuses it, fall through to the registered-app form instead of failing.
- **A registered app's client ID and secret** go in through the same write-only field as an API key (Path B), never
  chat. This is the Slack pattern we already have ("one internal Slack app per brand"), made general.
- **The exceptions table** (section 6.3) and the **renewal rules** (section 6.4).

### Path B: API key

New in this plan; the master plan doesn't mention key-only servers.

- **The connection records where the key goes**, not the key: the header name and prefix (`Authorization: Bearer ...`
  or `X-Api-Key: ...`) and the exact hosts it may be sent to.
- **The key is entered once, in the app**, in a write-only field on the tool's page. It's stored in the SignIn Durable
  Object, encrypted like every other token (`app/hub/crypto/`). No route returns it. It never reaches the agent's
  sandbox, a log line or a code-mode script.
- **It's checked before it's saved** (step 3). A wrong key never becomes a connected tool.
- **A key has no expiry**, so a dead one shows up only when used: a refusal from the server marks the tool "Needs a
  new key", the same way a dead sign-in shows Reconnect today.
- **Replacing a key** saves the new one only after it passes the check.

### Path C: no MCP address, so we build a connector

- **A tool many brands share** (an email or helpdesk service with no MCP server) becomes a reviewed connector in a
  pack, compiled into the hub like Shopify is today. This is the M7 pack seam; nothing new here.
- **A tool only one brand has** (their own back office, a niche service) gets a small connector Worker in that brand's
  Cloudflare account. It has no public address, the hub reaches it over a service binding and it speaks MCP, so the
  hub treats it like any other server. This is the same shape as the browser Worker in D8. Cloudflare's documented way
  to write one is `createMcpHandler` from its Agents SDK (a stateless handler; `McpAgent` is deprecated).
- **The connector never holds the tool's key and reaches only that tool's hosts.** The hub keeps the key and attaches
  it on the way out. This is a hard rule (it's the repo's "the hub makes every outside call" rule, and Executor
  enforces the same idea for its apps).
- **Every tool the connector offers is marked read or write by the person who wrote it.** Nothing is guessed from a
  name or an HTTP method. Unmarked means write, and writes ask (D3).
- **The Inhouse team's coding agent writes it from a kit:** a template, a checklist and one worked example on a
  fixture API. First version: a handful of hand-written tools per connector. Generating tools from an OpenAPI
  document is Later.

Open point, proved in the first Path C slice: the cleanest way to give a connector Worker the hub's guarded outbound
call (a binding back to the hub, or a capability passed with each call). If neither is clean, the fallback is to run
the connector's code inside the hub's existing no-network sandbox (`app/hub/codemode/`), which already has exactly this
shape: no network, one guarded binding.

### Step 3: check the connection

Before a connection is saved, and again from the Tools page on demand:

- With the credential: connect and list the first page of tools.
- Without it: the same call must be refused. That proves the credential is what grants access and that we aren't
  talking to an open server by mistake.
- No tool is called. The check never uses the vendor's other APIs, because an MCP token is often valid only for the
  MCP server it was issued for (Executor's guide).

### Step 4: review the tools

Unchanged from the master plan (4.4): the hub snapshots the tool list with a hash per definition, the Inhouse team
confirms the read list, a changed definition hides the tool, and unknown write tools always ask.

## 6. What we take from Executor

Each item: what it is, where it is in their code (paths at commit `d30f09c`), what we have, and what we build. We
write our own code in our own style. Their code is on the Effect framework with their own patches, which we don't use.

### 6.1 How to tell which path a tool needs

- **Theirs:** `packages/catalog/src/implementation/detection.ts` (the header comment, lines 1 to 19).
- **Ours today:** none. A connector's path is fixed at compile time in `app/hub/registry/registry.ts`.
- **Build:** the detect step in section 5, for the runtime registry (master plan 4.5, item 3).

### 6.2 Where an OAuth client comes from

- **Theirs:** `packages/app-templates/executor/skills/app-authoring/integrations.md`, "OAuth apps the user registers".
- **Ours today:** `client: 'preregistered' | 'dynamic'`, fixed per connector.
- **Build:** the lookup order in Path A, decided at connect time.

### 6.3 The exceptions table

Twelve ways real services differ from the standard. Each becomes one row of a table-driven fixture test.

| # | What the service does | Who (per Executor) | Right reaction | Their source |
|---|---|---|---|---|
| E1 | Leaves `token_type` out of a login answer | Shopify, ClickUp, Mailchimp | Treat it as Bearer | `oauth-protocol.ts` 693 to 697 |
| E2 | Uses its own name for the token type | Slack (`bot`) | Accept any type except DPoP | `oauth-protocol.ts` 795 to 799 |
| E3 | Sends `scope` as null, or not at all | Mailchimp | It granted what was asked; on renewal, what it held | `oauth-protocol.ts` 693 to 695, `oauth.ts` 568 to 571 |
| E4 | Returns scopes separated by commas | GitHub (`repo,gist`) | Split granted scopes on the service's separator | `oauth.ts` 570 to 571 |
| E5 | Reports an error with a success status | GitHub, Slack | Read the answer's `error` whatever the status | `oauth-protocol.ts` 356 to 366 |
| E6 | Rejects our client with its own code | GitHub, Salesforce, Dropbox | It's a client fault, not the account's | `oauth-protocol.ts` 345 to 354 |
| E7 | Refuses a renewal | Supabase Auth, GitHub, Slack, AWS Sign-In | Only "this grant is over" ends the login (section 6.4) | `oauth.ts` 354 to 369 |
| E8 | Publishes its issuer as a template | Microsoft (`{tenantid}`) | Match a tenant's issuer against the template | `oauth-protocol.ts` 543 to 549 |
| E9 | Refuses the `resource` parameter | Microsoft v2.0 (`invalid_target`) | Don't send it to that kind of server | `oauth-protocol.ts` 783 to 791 |
| E10 | Doesn't answer 200 at a metadata address | Apple (redirects), Atlassian (401) | Try the next address in the spec's order; never follow a redirect or accept another issuer's document | `oauth-protocol.ts` 1112 to 1117 |
| E11 | Sends `iss` on the callback when its issuer was derived, not published | Google | Ignore it then; check it when the issuer was published | `oauth-protocol.ts` 1688 to 1691 |
| E12 | Reads the client secret only from the request body | HubSpot | Use the body form when the server lists only that; otherwise Basic | `oauth.ts` 505 to 510 |

Paths are under `packages/sdk/src/implementation/`.

**Where the handling lives.** M4 adopts the official MCP client's own sign-in, given our `fetch` and our token store.
So for each row: first write the fixture test, then see what the official client does. Add our handling only where the
test fails. The likely homes are a small answer normaliser on the hub's own `fetch` (E1 to E6) and the hub's discovery
and connect code (E8 to E12). I haven't read the official client's sign-in code, so this split is a recommendation,
not a finding.

### 6.4 When is a login really dead

- **Theirs:** `packages/sdk/src/implementation/oauth.ts`, lines 354 to 369.
- **The rule:** a failed renewal ends the login only when the service says the grant itself is over (`invalid_grant`,
  or its own word for it). A fault with our client keeps the login and reports a client fault, because every account
  on that client shares it and ending them all would force every brand to sign in again once we fix it. An outage, a
  timeout, a 5xx or a 429 is temporary.
- **Ours today:** `RefreshClass` (`not_consumed`, `unclear`, `spent`) in `app/hub/oauth/protocol.ts`. The idea is
  already there; the generic path applies it too bluntly (section 7, F2).
- **Build:** the rule above in the generic path, as a property test over every status and error code.

### 6.5 Plain reasons a sign-in failed

- **Theirs:** `packages/sdk/src/implementation/oauth-diagnostics.ts`: a fixed list of reasons (for example "the login
  server's metadata is missing", "the answer wasn't JSON", "a field didn't match") built so no secret value can land in
  it.
- **Ours today:** a handful of codes; most refusals are `connect_refused`.
- **Build:** a fixed reason list behind `connect_refused`, shown in plain words on the Tools page and safe to log.

### 6.6 Checking a connection

- **Theirs:** the same guide, "Check an MCP account".
- **Ours today:** no check before saving.
- **Build:** step 3 in section 5.

### 6.7 Where a credential may go

- **Theirs:** `packages/apps/src/contracts/network.ts`: a credential goes only to its provider's hosts, only in its
  declared place, only over HTTPS, and never on a method that echoes the request back.
- **Ours today:** an exact host list per connector, enforced in `send()` (`app/hub/oauth/http.ts`).
- **Build:** the three extra rules as property tests on the hub's outbound call, for tokens and keys alike.

### 6.8 Settings a known server needs

- **Theirs:** `packages/catalog/src/implementation/overrides.ts`: PostHog's server is asked for `mode=tools` and
  Cloudflare's for `codemode=false`.
- **Why it matters to us:** we run our own code mode (D14). A server that offers its own should be asked for plain
  tools.
- **Build:** a per-server defaults entry in the reviewed manifests the master plan already lists for known servers.

### 6.9 How to build a connector

- **Theirs:** the same guide: pick by what the service offers (MCP, an OpenAPI document, GraphQL, anything else); set
  the things a service's own description can't be trusted to decide (which host may receive credentials, where the key
  goes); list what the connector will expose, and what it skipped and why, before it goes live; mark every tool's
  approval in code.
- **Build:** the checklist in the connector kit (Path C).

### 6.10 Their test scenarios, as our checklist

- **Theirs:** `e2e/tests/oauth-refresh-resilience.spec.ts`, `e2e/tests/oauth-renewal-interruption.spec.ts`,
  `e2e/tests/mcp-execute-failures.spec.ts`, and the tool-list scenarios in `e2e/test-plan.ts` (a server that adds tools
  without announcing them; a list that can't be refreshed).
- **Build:** read each list when writing M4's fixtures and take the cases we lack. We take the scenarios, not the code.

## 7. Flaws this found in our generic sign-in path

Only Slack is live, on its own branch of this code, so nothing is broken today. All four would bite in M4.

| # | Where | What happens | Fixed by |
|---|---|---|---|
| F1 | `app/hub/oauth/protocol.ts:268` | A login answer with no `token_type` is rejected | E1, E2 |
| F2 | `app/hub/oauth/protocol.ts:262` | Any 400 or 401 on renewal marks the login dead, even when the fault is our client's | 6.4 |
| F3 | `app/hub/oauth/protocol.ts:142` and `:267` | The issuer must match exactly, so Microsoft's shared sign-in fails; an error sent with a success status reads as "tool unavailable" and is never treated as a dead login | E8, E5 |
| F4 | `app/hub/signin/core.ts:953` and `protocol.ts:221` | A login answer with no `scope` fails the exact-scope rule, and comma-separated scopes are read as one scope | E3, E4 |

## 8. What we don't take

- **Their code mode runtime.** Their docs call its limits "cooperative, not process isolation". Ours runs with no
  network and hard caps.
- **Their approvals.** Ours does more (outbox, hold, Undo, limits, exact approvals).
- **Their upstream MCP client.** It's on an older version than M4 plans.
- **Their apps platform, catalog, dashboard, database and team model.** Not our product.
- **Any file copied as is.** It would bring the Effect framework and their patches with it.

## 9. Acceptance checklist

1. **Detect.** Six fixture addresses report the six outcomes in section 5, step 0. A fixture that answers with a
   firewall page reports "Blocked", not "Needs a sign-in". A request log shows no redirect followed, no credential
   sent and no tool called during detection.
2. **Exceptions.** Each of E1 to E12, planted on the fixture login server, gives the reaction in its row.
3. **Renewal.** On a refused renewal: `invalid_client` keeps the tool connected and reports a client fault;
   `invalid_grant` shows Reconnect; a 503 and a 429 retry later. A property test over every status and error code shows
   only a "grant is over" answer ends a login.
4. **Plain reasons.** Every refused connection shows one reason from the fixed list on the Tools page. A scan of the
   hub's logs for the run finds no token, key, code or verifier.
5. **API key.** A key entered once makes reads work. No route returns it. A wrong key is refused before it's saved. A
   key the fixture revokes turns the tool to "Needs a new key" on the next use. A property test shows a request
   carrying the key to a host off its list, or over plain HTTP, is never sent.
6. **Connection check.** After connecting, the check lists tools with the credential and is refused without it. The
   fixture's call log shows no tool call.
7. **Built connector.** A fixture REST API with no MCP address becomes a connected tool through the kit, with no
   change to hub code. Its key appears nowhere in the connector's source, bundle or logs. A call to a host off its list
   is refused. A tool the connector doesn't mark is treated as a write and asks.
8. **Roles.** A Member can't start a connection or enter a key. An Admin can do the credential step on a connection
   the Inhouse team prepared and nothing else (W1). Every connect, key change and disconnect is in the audit log
   with who did it.
9. **Known-server settings.** A fixture standing in for a server with its own code mode is asked for plain tools.
10. **Nothing regresses.** Slack's existing connector tests and the nightly connector cases pass unchanged.
11. **Credit.** Any closely carried-over list or rule names Executor, its commit and its MIT notice (section 13).

## 10. Edits to the master plan (done 2026-11-26)

- **Section 1 and D6.** Say who connects: the Inhouse team by default; the brand's Admin may give the login on a
  prepared connection (W1). Move "an Admin pastes any URL without us" to Later (W2).
- **Section 4.4.** Add the detect step, the three paths and the connection check. Add key-only and no-sign-in servers,
  which it doesn't mention.
- **Section 4.5, item 5.** Add the client lookup order, the exceptions table, the renewal rule and the plain reasons.
  Add the "test first, then see what the official client does" rule.
- **Section 4.5, item 6.** Add the planted faults E1 to E12 to the fixture login server.
- **Section 4.9.** No change. Note that reviewed manifests carry per-server settings (6.8).
- **Section 6 (adopt or build).** New row: "Sign-in exceptions and connection rules: learned from Executor (MIT),
  written and tested here".
- **M4 goal, Builds and Done when.** Add Path B, the detect step, the connection check and one built connector on a
  fixture API. Add checklist items 1 to 9 above to "Done when".
- **M7.** Note that a shared tool with no MCP server is a pack connector.
- **Section 12 (risks).** Add the two risks in section 14.
- **Section 13 (sources).** Add this plan's sources.
Also done 2026-11-26, outside the master plan:

- **`docs/decisions/`.** Record the "learn from it, don't run it" decision as the next numbered record and link it from
  P0 S4's "Why not self-hosted Executor".
- **`docs/adopted-libraries.md`.** Add a "learned from" entry: Executor, the pinned commit, and a re-scan of its
  exceptions each time a milestone touches sign-in.

## 11. Build slices

These fold into M4's own slices; M4 sets the order. Each is checkable on its own.

1. **Detect and plain reasons.** No token handling changes. Checklist 1 and 4.
2. **Exceptions and renewal**, with M4's client swap. Checklist 2, 3 and 10. High tier (it touches `app/hub/signin/`).
3. **API key path and the credential step.** Checklist 5 and 8. High tier (routes, the access matrix, `signin`,
   `crypto`), so it needs Wasim's OK.
4. **Connection check and known-server settings.** Checklist 6 and 9.
5. **Connector kit and one fixture connector.** Checklist 7. Starts with a short proof of the guarded outbound call.

## 12. Wasim's decisions (2026-11-26)

Wasim took every recommendation.

| # | Question | Decided |
|---|---|---|
| W1 | May a brand's Admin give the login (sign in, or enter a key) on a connection the Inhouse team prepared? | **Yes.** They usually hold it, and it keeps keys out of Slack and email. |
| W2 | Does "an Admin connects any URL without us" (D6 as written) stay in M4? | **Moved to Later.** It's not how the product is run, and it shrinks the hostile-server risk. In M4 the Inhouse team connects any address for a brand. |
| W3 | Where do built connectors live? | **Shared tools in this repo as pack connectors; a single brand's own tools in the private ops repo**, built from the kit here. Brand hosts and names stay out of this repo. |
| W4 | Is one built connector in M4 enough, or does Path C wait for the operator tools after M7? | **One in M4.** A brand whose key tool has no MCP server can't be served without it. |

## 13. Licence and credit

Executor is MIT, copyright 2026 Rhys Sullivan. We write our own code. Where a list or rule is carried over closely
(the exceptions table, the failure reason list), the module names Executor and the commit it came from, and Executor's
copyright line and MIT notice are kept with it, in that module's header comment (master plan, M4).

## 14. Cost, assumptions and risks

- **Cost:** no new paid service. A connector Worker runs in the brand's account on the Workers Paid plan the product
  already needs.
- **Assumption:** the first brands need a few tools each, so hand-written connector tools are enough for now.
- **Risk: the exceptions are second-hand.** They're Executor's reading of each service, and services change. We notice
  through fixture tests now and live sign-ins in Stage 2; the re-scan in section 10 catches new ones.
- **Risk: the connector's guarded outbound call.** It's the least-proven part of Path C. Slice 5 proves it first on a
  fixture, with the hub's existing sandbox as the fallback.

## 15. Out of scope and Later

- **Out of scope:** running Executor in the product; any change to permissions, the outbox or code mode's design.
- **Later:** an Admin connecting a URL without us (W2); connectors generated from an OpenAPI document; sign-ins that
  trade a username and password for a session cookie; a tool search beside `code_describe` once a brand has more
  tools than a list can hold.

## 16. Sources

Read on 2026-11-26.

- Executor source, commit [`d30f09c`](https://github.com/UsefulSoftwareCo/executor/tree/d30f09ccd5452042be5b588a5e4fc8d225a25412)
  (branch `v2`): the files named in section 6, `apps/hosted/self-host/README.md`, and
  [releases](https://github.com/UsefulSoftwareCo/executor/releases).
- Executor docs: [self-host](https://executor.sh/docs/run/self-host), [the MCP endpoint](https://executor.sh/docs/mcp),
  [tools and approvals](https://executor.sh/docs/concepts/tools-and-approvals),
  [API keys](https://executor.sh/docs/api-keys),
  [organizations and access](https://executor.sh/docs/concepts/organizations-and-access).
- `@modelcontextprotocol/sdk` 1.32.1, the published package (`LATEST_PROTOCOL_VERSION` is `2025-11-25`).
- Cloudflare: [build a remote MCP server](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/),
  [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/),
  [Containers image management](https://developers.cloudflare.com/containers/platform-details/image-management/),
  [Containers FAQ](https://developers.cloudflare.com/containers/faq/),
  [Containers snapshots](https://developers.cloudflare.com/changelog/post/2026-09-30-snapshots/).
