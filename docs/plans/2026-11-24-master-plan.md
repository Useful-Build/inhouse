# Master plan: one powerful agent

Status: **approved by Wasim on 2026-11-26; Stage 1 (Build) in progress.** Drafted 2026-11-24.
Replaces the [2026-11-22 master plan](../history/2026-11-22-master-plan.md) (now legacy). Decision record:
[0026](../decisions/0026-one-agent-replaces-watch-act-run.md). Council material (gitignored):
`verify/agent-direction/` (two rounds by GPT-6.2 Sol xhigh, Claude Fable 5.2 high and Gemini 4 Neon xhigh, with Opus 5.5
as coordinator) and `verify/agent-direction/doc-check.md` (every locked choice checked against primary docs on
2026-11-24).

## 1. The product in plain words

**Inhouse is an AI team member for a brand.** It's installed in the brand's own accounts, connected to the tools the
team already uses (the store, Slack, email marketing, files and any other tool, through its MCP address or a small
connector we build), and run for the brand by Inhouse's AI expert (Wasim), who sets it up, connects its tools, watches
it, fixes it and improves it.

- **You talk to it like a colleague.** Ask "why did returns jump this week?" and it digs through orders, return reasons
  and Slack and answers with evidence and a chart. Say "tag those orders and tell the warehouse channel" and it does
  it. Asking and doing happen in the same conversation. There is no read-only mode and no separate action mode.
- **It takes on big jobs.** "Review every product's stock against last month's sales and draft a restock list" can run
  for an hour or more. You can close the app; it keeps going, splits the work into parallel parts when that helps,
  searches the web, uses a browser for pages that need one, and comes back with the finished file and a notice.
- **It asks before it acts, like a sensible new hire.** The first time it wants to do a new kind of thing (tag an
  order, post in a channel) it asks: **Allow once** or **Always allow**. After "Always allow" it stops asking for that
  kind of thing, within limits. Some things always need a clear yes for that exact action: anything touching more than
  5 records at once, deletions, refunds and other money, anything a customer sees, and anything that can't be undone.
  Everything it does is logged, and most things can be undone.
- **It can work on its own, if you switch that on.** One switch: **Proactive**. When it's on, the agent checks your
  tools in the background and brings you a short morning brief (what changed, what it handled, what needs a decision)
  and pings you only when something is urgent. When nothing matters, it stays quiet. You set a monthly budget for this
  background work (for example $100, $200 or $1,000). When the budget runs out, background work pauses and chat keeps
  working.
- **It's a team's agent.** It remembers how the brand works, each person can only approve what their role allows, and
  admins see who allowed what.
- **E-commerce first, not e-commerce only.** The core is a general business agent. For a Shopify brand it comes with
  store tools, store know-how and store checks. Later the same core can serve another sector with other tools and
  know-how.

**Our edge** is not the agent alone (big labs will give solo founders a decent agent): it's a team agent, installed in
the brand's own accounts as an internal tool, with an AI expert who runs it for them.

## 2. What changed and why

The old plan grew the agent in three tiers over time: **Watch** (read-only), then **Act** (writes), then **Run**
(routines working alone). Watch was built and was being prepared for a live soak.

Wasim decided on 2026-11-24 that a read-only tier won't be worth much a year from now: Claude has merged chat with
Cowork and the other big agents act as well as read. So the tiers are retired. There is one agent that reads and acts,
with permission prompts in the flow, plus one proactive switch.

Also decided: **build first**. The old Stage 2 (connecting house to live Shopify and Slack) and Stage 3 (final evals,
soak, drills, fresh-account install) are **paused** until the agent is built. "A powerful car first, then decide where
to drive it, then prove it on the road."

## 3. Decisions locked (Wasim, 2026-11-24)

| # | Decision |
|---|---|
| D1 | **One product, one agent, one app.** Watch, Act and Run are retired as tiers, as stages in code (`app/server/stage/`) and as words on screen. No presets and no per-class switchboard. |
| D2 | **Two controls only:** the brand's **Proactive** on/off switch (default **off**) with its own monthly budget, and **permission prompts in the flow** (Allow once / Always allow). |
| D3 | **Hard guardrails that "Always allow" never unlocks** (each needs approval of that exact action, every time): moves money; reaches a customer or publishes publicly; deletes, cancels or can't be undone; changes permissions, apps, billing or connections; touches **more than 5 records** in one action, or would pass a grant's count limit; a write tool on an MCP server whose effect Inhouse hasn't reviewed; any step in a logged-in browser session. No exceptions for money or customer actions at launch; narrow, limit-bound exceptions can come later, only after the write-safety evals show zero bypasses. |
| D4 | **Who grants what.** A member's "Always allow" covers only that member's own chats and only what their role may do. Only an admin can grant for the whole brand. Proactive runs use only admin (brand) grants, never a member's. Inhouse sets a per-brand ceiling above all of it (which actions exist, the bulk threshold, the largest budget). |
| D5 | **"Powerful" comes first:** long-running jobs, subagents, any MCP server by URL, web search and fetch, browser use, and a capability eval that proves the agent finishes real multi-step tasks. |
| D6 | **Any tool** (amended 2026-11-26). The Inhouse team connects any tool for a brand: any MCP server address, with a sign-in, an API key or neither, and a tool with no MCP address through a connector we build. A brand's Admin may give the login (sign in, or enter an API key) on a connection the Inhouse team prepared. An Admin connecting an address without us is Later. Reads work after the Inhouse team confirms the tool list; writes follow D3 and D4. The hub speaks the current MCP spec (2026-07-28) and falls back to older servers (section 4.5). |
| D7 | **Web search and web fetch** are the Agent SDK's built-in tools; the agent gets free use of them. Each stays a brand on/off toggle (`t:websearch`, `t:webfetch`). Fetch opens to any public site once the data-leak eval passes with it open. |
| D8 | **Browser use is an optional add-on**, adopted not hand-built: Cloudflare Browser Run (in the brand's own account, about $0.09 an hour past 10 free hours a month), connected as one more MCP server, public pages only; logins by handing the live browser to a person. Dropped without harm if it proves hard. Swappable (Browserbase, Kernel, Steel, Playwright MCP) because it's just an MCP server. |
| D9 | **Adoption first.** Keep what's built and works (Claude Agent SDK runner, BrandAgent, hub, D1 ledger); adopt maintained parts for the rest; hand-build only what is the product itself (permissions, outbox, findings, the app). A better maintained option may replace a built part only with a clear, verified reason. |
| D10 | **Budget scope.** The proactive budget caps model spend first, with hard runtime quotas. An all-in bill (compute, browser minutes, vendor fees) comes later. |
| D11 | **Paid evals at the gates.** Small capped paid eval runs at M3 (write safety) and M6 (capability), each with Wasim's OK on the cap at the time. The full all-model sweep stays in Stage 3. |
| D12 | **Order.** Build (Stage 1) now. Connection (Stage 2) and proving it live (Stage 3) paused. Operator tools after the build. |
| D13 | **Pack seam last.** Build against Shopify, then cut the sector "pack" out of working code (M7). |
| D14 | **Code mode for every tool** (Wasim, 2026-11-26). The agent can use any connected tool (Shopify, Slack, any MCP server) from a short script that calls the tools and returns only what it needs, so large results never fill the context window. Built in M4 (section 4.9). |

**Amended 2026-11-26:** D6 now says who connects a tool. Wasim took every recommendation in the
[connect any tool plan](2026-11-26-connect-any-tool.md) (section 12): a brand's Admin may give the login on a
connection the Inhouse team prepared (W1); an Admin connecting an address without us moves to Later (W2); shared
built connectors live in this repo and one brand's own in the private ops repo (W3); M4 builds one connector (W4).

## 4. How it works

### 4.1 One agent, one engine (kept)

The agent is the **Claude Agent SDK** running in a sandboxed Cloudflare container (`app/runner/`), driven by one
Durable Object per brand, **BrandAgent** (`app/server/do/brand-agent/`), which owns turns, the model gate, scheduling
and deferred calls. Model calls go through `app/server/egress/model.ts` and the spend ledger
(`app/server/usage/ledger.ts`). Tools reach the outside world only through the **hub** (`app/hub/`), a separate Worker
with no public route that holds every tool login (SignIn DO, encrypted) and makes every outside call.

The council checked the alternatives on 2026-11-24 and kept this engine:
- **Claude Managed Agents** is still beta, not eligible for zero data retention (sessions live at Anthropic) and budgets
  per session, not per month; switching would take weeks and give less control. Re-check at GA.
- **Cloudflare Agents SDK** has no Claude harness and would mean rewriting BrandAgent.
- **Cloudflare Workflows** isn't needed yet: BrandAgent's scheduler already persists deferred calls and due tasks, and
  Workflow steps retry (at least once), which an outbox send must not. Adopt it the first time a job needs several
  durable multi-day waits.

### 4.2 Long jobs and subagents

- **Long jobs.** A job is a chain of turns on one SDK session. BrandAgent auto-continues it past the per-turn limits
  (today 45 minutes and 25 model turns) until it's done, hits its job budget or an 8-hour cap. Progress comes from the
  SDK's task events (`map-events.ts`); a finished job leaves a result card plus a bell or Slack notice. Cancel works at
  any time. If the container dies, the job resumes from the last R2 session checkpoint (`app/runner/src/store/`);
  authority is re-checked on every continuation.
- **Subagents.** The SDK's `Agent` tool is already allowed (`app/runner/src/guards/lists.ts`) but no subagents are
  defined and the parent model is forced. Define Inhouse-owned subagents (a researcher on a cheaper model, an analyst)
  through the SDK's `agents` option. The SDK defaults are 3 levels deep and 20 at once; we start at depth 1 and 4 at
  once (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`) and deny fork subagents.
  Subagents read and analyse; they can't request writes. Their spend counts in the SDK's total and on our ledger.
- **Budgets are ours, not the SDK's.** The SDK's `maxBudgetUsd` can overshoot by one response and resets when a
  session resumes, so a job's budget is enforced by our ledger reservations across every continuation; `maxBudgetUsd`
  is only a per-turn backstop.
- **SDK version.** The runner pins 0.3.328 (latest 0.3.331, 2026-11-23). At M1, move to the newest release that's at
  least two weeks old at that time.

### 4.3 Web search, web fetch and browser

- **Search** sends only the query out, so it's low risk. **Fetch** can leak data through the URL it calls, and last
  week's paid run had a real bypass on a planted link (X03, `app/evals/results/2026-11-23-p4-evals.md`). So fetch gets
  a **leak check** before it opens to any public site: a URL carrying data the agent just read from private tools is
  refused (`app/server/egress/webfetch.ts`). Bash keeps no network. Proactive runs fetch only sites the brand listed or
  that the run's own search returned.
- **Where web traffic goes.** WebFetch runs from the runner container, not through the hub; the container's egress
  hands it to the Worker's egress check (`app/server/egress/webfetch.ts`), which is where the host rules and the leak
  check live. WebSearch is Anthropic's server-side search: the model picks its domain filters and permission rules
  can't narrow it, so it's governed only by the brand toggle. WebSearch isn't available on Amazon Bedrock, which
  matters when the Bedrock fallback is built.
- **Browser** (D8): Cloudflare Browser Run as the browser, behind a small Worker with no public route, connected through
  the hub like any MCP server; navigation, reading and screenshots on public pages; the same web toggle and leak check
  (Browser Run's `outboundByHost` can route page traffic through our check); minutes metered. Logins only by Live
  View handoff to a person (up to 30 minutes), in chat, never proactive. Pricing: 10 browser hours a month included on
  Workers Paid, then $0.09 an hour. **Pick the MCP layer at build time:** Cloudflare's `@cloudflare/playwright-mcp`
  0.0.6 tracks upstream Playwright MCP 0.0.30 while upstream is at 0.0.86, so upstream Playwright MCP driving Browser
  Run over CDP may be the better adoption. Sites with bot protection will see a bot (Browser Run signs its requests
  with Web Bot Auth).

### 4.4 Any MCP server

**Who connects** (D6): the Inhouse team sets up each connection on the Tools page. Whoever holds the tool's login
gives it once, in the app, never by chat or email: the Inhouse team, or the brand's Admin on a connection the team
prepared. Members and Admins ask for a tool with **Request a tool**. Reads work in chat and in proactive work; writes
go through permissions and the outbox.

**One connect flow, three paths** (details in the [connect any tool plan](2026-11-26-connect-any-tool.md), section 5):
- **Detect.** From a pasted address the hub asks the server a few questions with no credential (`server/discover`,
  then `initialize`) and reports one outcome: works with no sign-in, needs a sign-in, needs a key, blocked (a firewall
  or web page answered), or no MCP address. It never follows a redirect, sends a credential or calls a tool.
- **Path A, sign in:** section 4.5, item 5.
- **Path B, API key or no sign-in.** The connection records where the key goes (header, prefix and exact hosts), not
  the key. The key is entered once in a write-only field, stored encrypted in the SignIn DO and checked before it's
  saved. No route returns it, and it never reaches the sandbox, a log or a script. A refusal on use marks the tool
  "Needs a new key". A server that needs nothing skips the key.
- **Path C, no MCP address.** A tool many brands share becomes a reviewed pack connector in this repo. One brand's own
  tool gets a small connector Worker in that brand's account, built from a kit in this repo and kept in the private ops
  repo. It has no public address, speaks MCP over a service binding, never holds the key and reaches only its tool's
  hosts. Every tool it offers is marked read or write in code; unmarked means write.
- **Check.** Before saving, the server lists tools with the credential and refuses the same call without it. No tool
  is called.

How it's built:
- **Protocol: the official MCP TypeScript SDK** (`@modelcontextprotocol/client` 2.4.0, pinned), on the
  **2026-07-28 spec**, with fallback to servers still on older versions. It replaces our hand-written client
  (`app/hub/connectors/mcp/client.ts`), which only does `initialize` and `tools/call` on the 2025-11-25 spec and can't
  reach a new-only server. Details of the upgrade and what we build around it: section 4.5.
- **Logins stay in the hub** (SignIn DO). Not the Agent SDK's own MCP config (tokens would sit in the sandbox the agent
  runs in) and not Cloudflare's Agents MCP client (needs their Agent class and keeps tokens in its own storage).
- **Tool snapshot.** On connect, the hub lists the server's tools and stores each with a hash of its definition. The
  Inhouse team confirms the read list. If a tool's definition changes later, it's hidden until re-confirmed (guards
  against a server swapping a safe tool for a harmful one).
- **Untrusted by default.** A tool's own annotations ("read only", "not destructive") are hints, never authority. Tool
  descriptions and results are treated as untrusted text. Unknown write tools always ask (D3) unless Inhouse has
  reviewed the server with a manifest that classifies its operations.
- **Shopify and Slack** stay on their existing connectors and gain writes. Shopify's own merchant Admin MCP isn't
  public yet; when it is, it can sit behind the hub like any other server.

### 4.5 The MCP 2026-07-28 upgrade

**In plain words.** MCP is the plug that lets our agent use other companies' tools. The July 2026 version changed how
the plug works. Before, the agent had to "dial in" first and keep a line open for each tool server. Now every request
stands on its own, like a letter with the return address and rules written on the envelope. That's simpler to run and
fits Cloudflare well. The catch: old-style and new-style servers can't understand each other unless the client speaks
both. Since any address can be connected, our hub must try the new style first and fall back to the old style for
servers that haven't upgraded. Sign-in changed too: instead of registering our app separately with every company, we
publish one public "ID card" page that any login server can read, and we must check a new stamp on each login reply to
be sure it came from the right company. Servers still describe their own tools, and those descriptions can change or
lie, so we keep approving tools ourselves and re-check them when they change. Done right, "connect any tool" gets
safer and simpler. Done wrong, new servers simply won't connect.

**What changed** (spec changelog, current version 2026-07-28):

| Change | What it means for us |
|---|---|
| No `initialize` handshake and no `Mcp-Session-Id`; every request carries its version and client capabilities in `_meta` | Our client starts every call with `initialize`; a new-only server answers 400. The spec's own table says an old client and a new server "Fails". |
| New required headers `Mcp-Method`, `Mcp-Name`, and `x-mcp-header` values mirrored from tool parameters; header and body must match | Needs each tool's `inputSchema` at call time, so we must fetch and keep `tools/list`. |
| New `server/discover` call; no version negotiation (a wrong version gets error -32022 with the supported list) | The hub probes with `server/discover`, caches each server's era per origin, and falls back to `initialize` for old servers. |
| Server-to-client requests replaced by `resultType: "input_required"` results the client answers and retries | A server can ask for more input mid-call; the hub must handle it (or fail cleanly), not report "unavailable". |
| `tools/list` must carry `ttlMs` and `cacheScope`; lists may vary by the login used | Snapshot per connection and login, refresh by `ttlMs`. |
| A broken stream loses the request (no resumption); progress messages may come before the answer | The hub retries a lost request and accepts multi-event streams (ours rejects them today). |
| Tasks moved to an official extension; Roots, Sampling, Logging and the old HTTP+SSE transport deprecated; `ping` removed | We use none of these; don't start. |
| **Sign-in:** Client ID Metadata Documents (CIMD) preferred, Dynamic Client Registration deprecated (still needs `application_type`); `iss` check on the login reply is a new must (RFC 9207); credentials keyed by the login server's issuer; scopes from the 401 challenge with step-up on 403 | Our sign-in does registration only, without `application_type`, no `iss` check, static scopes, no step-up. |
| Tool annotations stay untrusted; the spec has no tool pinning | Our own approvals and definition hashes are the right design; pinning is our job. |

**What we build around it (M4):**
1. **Adopt `@modelcontextprotocol/client` 2.4.0** (2026-10-23, the official SDK's v2 client) inside the hub with
   `versionNegotiation: { mode: 'auto' }` (new style first, then old). It runs on Workers, takes our own `fetch` (so the
   hub's egress guard sees every request), lets us store tokens ourselves (`OAuthClientProvider` backed by the SignIn
   DO) and supports CIMD, the `iss` check and `application_type`. Note: its default is old-style only, so `auto` must
   be set explicitly. Dependencies: zod 4 (matches ours), jose, eventsource, pkce-challenge and its core package; it's
   a hub dependency, so the hub-isolation rule (no npm imports in code bundled into the hub from outside it) still
   holds.
2. **Our client ID document**: one public HTTPS page describing Inhouse's client, served per brand account (the hub has
   no public route, so it's served by the product Worker or a static path; decided in M4, High tier).
3. **A runtime registry per brand** (D1): the server URL, its era, the login server's issuer, the tool snapshot with
   definition hashes and `ttlMs`, the confirmed read list, and reviewed operations. Today's compile-time registry
   (`app/hub/registry/registry.ts`) stays for Shopify, Slack and reviewed connectors.
4. **Drift guard**: refresh `tools/list` by `ttlMs` and on `HeaderMismatch`; a changed definition hides the tool until
   re-confirmed.
5. **Sign-in upgrade** in `app/hub/oauth/`: CIMD first, registration as fallback with `application_type: "web"`, the
   `iss` check, issuer-keyed credentials, scopes from the challenge, step-up on `insufficient_scope`. Plus, from the
   [connect any tool plan](2026-11-26-connect-any-tool.md) (section 6):
   - **Where the client comes from, in order:** a client saved for this server, our client ID document, registration,
     then an app the Inhouse team registers with the service. Its ID and secret go in through Path B's write-only field.
   - **The sign-in exceptions:** twelve ways real services break the standard (E1 to E12, learned from Executor). Test
     first, then see what the official client does; add our handling only where the test fails.
   - **The renewal rule:** only "this grant is over" (`invalid_grant`) ends a login. A fault with our client keeps it
     and reports a client fault; an outage, timeout, 5xx or 429 is temporary.
   - **Plain reasons:** a fixed list behind `connect_refused`, shown on the Tools page and safe to log.
6. **Prove both eras** against fixture servers: one 2026-07-28-only, one 2025-11-25-only (the existing Slack shape),
   one that asks for input mid-call, one that changes a tool. The fixture login server can plant each of E1 to E12.

### 4.6 Permissions: Allow once and Always allow

The server decides, never the model, the SDK or the browser. The runner stays `permissionMode: 'dontAsk'`; the SDK's
own "remember this" rules (written to files in the container) are not used.

- **A kind of action** = tool account + operation + scope + limits. Example: "add a tag to one order on Store A, up to
  50 a day". Operations come from an **operation table** (P6's design, `app/server/outbox/operations/`): moves money,
  reaches a customer, reversible, safe to retry, units, how to find the scope. For an MCP tool with no table entry, the
  kind is server + tool + definition hash.
- **Grants** live in a new D1 table `permission_grants` (registered in `app/ops/tables/`): who it's for
  (`member:<id>` or `brand`), account, operation, scope, limits, granted by, uses, revoked at.
- **The decision** (`decide()`, replacing the stage question in `app/server/stage/watch.ts` at the same call sites,
  starting with `app/server/egress/hub.ts`) returns one of:
  - **run**: a live grant covers it and the limits reserve atomically in D1; the action enters the outbox with a
    10-second hold and Undo.
  - **ask**: no grant and no guardrail; a card in the chat with **Allow once** and **Always allow**. If nobody answers
    within about 2 minutes, the write tool returns "waiting", the card stays in Approvals and a later answer sends the
    action and resumes the chat in a new turn. (The SDK's `defer` works only when a turn makes a single tool call, so
    the design can't rely on it when the agent calls tools in parallel; it's used for `question_ask` where it fits.)
  - **exact**: a guardrail applies; one **Approve** button bound to this exact action (and, for a batch, the full item
    list).
  - **refuse**: not in the table, over Inhouse's ceiling, or the tool account is paused.
- **Checked twice**: when the agent asks and again at the moment of sending (one conditional D1 update). A grant
  revoked, a role lowered, Pause pressed or the proactive switch turned off during the hold stops the send.
- **Revoking**: one flat list in Settings ("What the agent may do without asking", each row with Remove) and "Stop
  allowing this" on the Activity row. Grants also lapse when a member's role drops, a tool is re-scoped, an MCP tool's
  definition changes or Inhouse lowers the ceiling.
- **Gentle nudge**: after a few "Allow once" answers for the same safe kind, the card offers "Always allow" more
  prominently. It's not a setting.
- **The outbox** (P6's design): `waiting → approved → sending → sent | failed | needs_check`. The hub's write
  entrypoint answers only the outbox dispatcher, so the agent's sandbox never holds a write path. An unclear outcome
  becomes "Needs a check" until reconciled; it's retried only when the operation is known safe to retry. Undo before
  sending; after sending, a compensating action where the tool allows, as a new action.
- **The agent's own tools**: the stubbed `approval_*` and `question_ask` tools (`app/server/mcp/tools/stubs/index.ts`)
  are built.

### 4.7 Proactive mode

- **Switch**: one brand switch, default off. Off means no background run can start and unclaimed background writes
  don't send (property-tested). Chat, "Run now" and team routines keep working. Quiet hours and per-check mute sit
  under it.
- **Engine: the existing routines** (`app/server/routines/`), extended. OpenClaw, the best-known always-on agent,
  retired its separate "heartbeat" into ordinary scheduled automation jobs, switched off by default; we do the same.
  - **Signals cost almost nothing**: schedules (exist), polls (a saved read-only code-mode script plus a threshold
    through `app/hub/codemode/`), and events (Shopify webhooks, later: they need the public webhook route, which is
    Stage 2).
  - **Triage before spending**: deterministic filters first, then a small-model check (Haiku) that answers nothing,
    tell, ask or act. "Nothing" writes nothing.
  - **Full run only when earned**, as the system member `m_system`, with brand memory and brand grants only.
- **Watchlist**: brand-editable checks in plain words ("tell me when a top-20 SKU has under 7 days of stock"). The
  agent can propose entries; an admin accepts them. The morning check becomes the Shopify pack's first default.
- **Findings, not noise**: one Today card per issue (dedupe key per check and entity), updated in place as evidence
  changes; a morning brief; urgent items to the bell and a listed Slack channel. Everything handled shows in Activity
  with Undo where possible. Missing tool data shows as incomplete coverage, not silence.
- **Budget**: a separate proactive pool (`s:cap:proactive`) beside the brand's monthly cap, reserved through the same
  ledger, with a daily pace (monthly ÷ days). At 80% of the day's pace it drops to the brief and urgent checks; at 100%
  of the month it pauses with one notice. Chat is never blocked by the proactive pool.
- **Slack scope**: today's Slack login is a person's and can see their private channels. Unattended runs read only
  channels the admin listed.

### 4.8 Core and the Shopify pack

Built against Shopify first (D13). At M7, a **pack** becomes one folder (`app/packs/<id>/`) with a manifest: its
connectors and scopes, operation entries, skills, prompt fragment, default watchlist checks, Today card words, evals
with fake upstreams, and demo data. The core (runner, BrandAgent, hub core, permissions, outbox, routines, Today,
memory, skills engine, evals harness, app) imports nothing from a pack (lint rule). A toy second pack on the fixture
MCP server proves the seam.

### 4.9 Code mode for every tool

**In plain words.** Instead of calling tools one at a time and reading every full answer, the agent writes a short
JavaScript script: "fetch the last 500 orders, keep the ones returned this week, count them by reason". The script runs
next to the tools and only the small answer comes back to the agent. That's faster, picks the right tool more often and
saves the context window and the budget.

**Today** (`app/hub/codemode/`, P5): it works for Shopify only. A script runs in a Cloudflare Dynamic Worker with no
network and can reach exactly one thing, `shop.graphql`, with caps on calls, bytes read and time. In P0 it cut about 88K
characters of raw order data to 199 to 1,131 for the model. Slack and other MCP tools can't be used from a script.

**What M4 adds:**
1. **One `tools` object per script**, built from the brand's connections: `tools.<server>.<tool>(args)` for every
   confirmed read tool on every connected MCP server (Slack and any server added by URL), beside `shop.graphql`. Each
   call goes through the hub's normal path (SignIn, egress guard, definition-hash check), so a script can do nothing a
   single tool call couldn't.
2. **Typed signatures from the tool snapshot.** The hub turns each tool's `inputSchema` into a short TypeScript
   declaration. A `code_describe` tool hands the model only the types it asks for, so the full list never fills the
   context. Adopt only the pure helpers of `@cloudflare/codemode` 0.5.6, pinned exactly (`jsonSchemaToType`,
   `escapeJsDoc`, `sanitizeToolName`; its core works with the v2 MCP client since 0.5.1). Don't adopt its executor or
   runtime: our runner is stricter (no network, outside deadline, CPU and return caps), and its approval flow runs an
   approved write when a script replays, which breaks item 4.
3. **Same caps, shared across all tools** (calls, bytes read, deadline), one call in flight at a time. A reviewed
   manifest can carry a server's own settings: a server that offers its own code mode is asked for plain tools.
4. **Writes from a script don't run in the script.** A script may *propose* writes (`tools.<server>.<tool>` on a write
   tool returns a proposal). When the script ends, the proposals go through `decide()` together: covered ones enter the
   outbox, the rest become one card, and more than 5 records is one batch card with the full list (D3). The sandbox
   still never holds a write path.
5. **Untrusted text stays untrusted.** Tool results a script returns are marked the same way as direct tool results,
   and tool descriptions inside the generated types are untrusted text too.
6. **Cross-server leak guard.** A script could pass data read from one server into a read call on another. Data from
   a private tool may only flow to servers the admin marked trusted; others refuse it (the same idea as the fetch leak
   check, section 4.3).

**Checked and not used (2026-11-26):** Claude Code's experimental Code Mode (refuses to run through a proxy, which our
runner uses for model calls, and is off for zero-data-retention organizations); the Claude API's programmatic tool
calling (code and raw tool results sit in Anthropic's container for up to 30 days, not ZDR-eligible, no Agent SDK
switch). Re-check both when they're GA. The MCP spec has no code-mode extension. Notes:
`verify/stage1-build/code-mode-research.md`.

**Done when:** a script joins Shopify orders with Slack messages and a fixture MCP server's data and returns a small
answer; a changed tool definition is refused inside a script; a script proposing 40 tags yields one batch card; the
caps hold across tools (property test).

## 5. What's already built (kept)

| Area | Where | Fate |
|---|---|---|
| App and seam | `app/src/`, `AgentClient` (`app/src/agent/types.ts`), `HttpAgent` | Keep; screens change in M2, M5 |
| Worker, auth, D1, R2, audit, backups, export, retention | `app/server/`, P2 and P8a | Keep |
| Agent engine | Agent SDK 0.3.328 in the runner, R2 session store, deferred calls (`app/runner/src/session/`) | Keep, extend (M1) |
| Runner sandbox | guards, per-session users, proxy (`app/runner/src/guards/`), pool (`app/server/do/runner/`) | Keep |
| BrandAgent | turns, model gate, scheduler (`app/server/do/brand-agent/`) | Keep, extend |
| Hub | SignIn DO, OAuth, registry (read only), Shopify reads, Slack MCP reads and delivery, code mode | Keep, extend (M2, M4) |
| Inhouse MCP server | memory, history, notifications, routines, team, skills; approval stubs (`app/server/mcp/`) | Keep, build the stubs (M2) |
| Memory and skills | D1 memory with team approval; plugin and brand skills | Keep |
| Routines, Today, notices | `app/server/routines/`, `today/`, `notices/`, `notify-slack/` | Extend into proactive (M5) |
| Usage and budget | monthly cap and atomic ledger (`app/server/usage/`) | Extend with the proactive pool (M5) |
| Safety switches | `app/server/stage/watch.ts` (stages), web toggles, Pause | Stages retired (M2); web toggles and Pause kept |
| Evals | `app/evals/` (product, read-side, exfiltration, morning-check, store-data, connectors) | Keep, add write-safety and capability sets |

Open PR: **#391** (prompt fix: never repeat links from files or tool results). It's reviewed; it merges with the next
prompt change that runs evals (M2 removes "read only" from the prompt), and its eval results are committed then.

## 6. Adopt or build

| Piece | Adopt | Build (ours, because it's the product) |
|---|---|---|
| Agent loop, sessions, subagents, web tools | Claude Agent SDK (kept) | Job layer, subagent definitions and caps |
| Durable timing | Durable Object alarms and BrandAgent scheduler (kept) | Job continuation |
| MCP protocol and sign-in | Official MCP TypeScript SDK, MCP 2026-07-28 spec | Hub connect flow, tool snapshot and drift guard |
| Sign-in exceptions and connection rules | Learned from Executor (MIT), not run | Written and tested here |
| Shopify, Slack | Shopify Admin GraphQL, Slack MCP and Web API (kept) | Write operations in the operation table |
| Browser | Cloudflare Browser Run + Playwright MCP | Thin Worker, quotas, toggle |
| Webhook buffering (later) | Cloudflare Queues | Verified, deduped intake |
| Permissions, outbox, approvals | none fits (typed cards, exactly-once sends, revision-bound approvals) | `decide()`, grants, outbox, cards |
| Proactive triage | Haiku through the existing model path | Watchlist, findings, pace |
| Evals | Anthropic's outcome grading with repeated trials | Write-safety and capability sets |

## 7. Stage 1: Build

Milestones run in this order; M1 and M2 run side by side (different code). Each lands through `AGENTS.md` section 5
(feature branches, risk-tiered review per `REVIEW.md`, light checks locally, heavy suites in CI). Milestones touching
prompts, migrations, `app/ops/`, `app/hub/{signin,crypto,scope}/`, routes or the access matrix are **High tier**
(Fable 5.2 + Gemini 4 Neon + Wasim's OK). Every user-facing change updates `FEATURE_MAP.md`.

| # | Milestone | Status |
|---|---|---|
| M0 | Built base (section 5) | Done |
| M1 | Powerful core | In progress |
| M2 | Permissions and the first write | In progress |
| M3 | Guardrails and the write set | To build |
| M4 | Any MCP (+ optional browser) | To build |
| M5 | Proactive mode | To build |
| M6 | Capability gate | To build |
| M7 | Pack seam | To build |
| After | Operator tools | After the build |

### M1: Powerful core

- **Goal (plain):** the agent can take on a long job, keep going after you leave, split work across helpers and use
  the web.
- **Adopts:** Agent SDK sessions and resume, subagents, WebSearch and WebFetch.
- **Builds:** the Agent SDK upgrade (newest release at least two weeks old); the job layer (auto-continue, progress,
  cancel, resume after container loss, result card and notice, job budget on our ledger);
  subagent definitions with depth 1 and 4 at once, cheaper model for research; web toggles as brand admin settings;
  the fetch leak check; the capability eval skeleton (`app/evals/capability/`).
- **Done when:** a scripted 2-hour job survives a closed tab and a killed container and ends with a result and a
  notice; subagent spend is on the ledger; with web off, zero web requests; fetch stays on its host list until the
  leak eval passes.

### M2: Permissions and the first write

- **Goal (plain):** the agent can do a first real thing in a tool, asking the way Claude does, and nothing goes out
  without a grant or an approval.
- **Adopts:** P6's outbox design and the SDK's `defer`.
- **Builds:** retire the stages (`app/server/stage/watch.ts` → `decide()`); remove "read only" from the prompt
  (`app/server/prompt/system.ts`, `connected.ts`, with #391 and committed eval results); `permission_grants`; the
  operation table; the outbox with hold, Undo and `needs_check`; the hub's write entrypoint for the dispatcher only;
  the Allow once / Always allow card in chat and in Approvals; the grants list; `approval_*` and `question_ask`; the
  first two writes on the fake upstream: an internal order tag and a post to a listed Slack channel.
- **Done when:** a property test shows no outside write without a live grant or an exact approval; revoke and Pause
  during the hold stop the send; an ambiguous send becomes "Needs a check"; with zero grants every existing read test
  still passes; P6 acceptance items that apply pass on the test build.

### M3: Guardrails and the write set

- **Goal (plain):** the hard rules hold, even when someone tries to trick the agent.
- **Adopts:** P7's atomic limit reservations.
- **Builds:** grant count limits and the bulk rule (more than 5 records, or past a grant's count, becomes one batch
  card with the full list); money, customer, destructive and permission operations as exact-only; the Shopify write set
  the brand needs first (for example notes, draft orders, stock adjustments within limits) on the fake upstream; the
  write-injection eval set (planted orders, Slack messages and tickets trying refunds, extra recipients or limit
  bypasses).
- **Done when:** a loop of 500 allowed writes stops at the limit and becomes one card; revoke during the hold stops
  the send; the injection set shows zero bypasses on the scripted run and on **one capped paid run** (D11).

### M4: Any MCP (and the optional browser)

- **Goal (plain):** the Inhouse team can connect any tool a brand uses (an MCP address with a sign-in, an API key or
  neither, or no MCP address through a connector we build), and the agent can use it safely.
- **Adopts:** the official MCP TypeScript SDK on the 2026-07-28 spec (section 4.5); later Cloudflare Browser Run.
- **Builds:** code mode for every tool (section 4.9); section 4.5's list: the client swap with `mode: 'auto'`; the client ID document; the runtime registry
  per brand; the sign-in upgrade (CIMD, `application_type`, `iss` check, issuer-keyed credentials, scope step-up);
  connect by URL with tool snapshot, definition hashes and Inhouse team confirmation; drift hides a tool;
  untrusted-text handling; MCP writes through the outbox; optional reviewed manifests for known servers, with
  per-server settings; fixture servers for both eras, mid-call input and a changing tool (one Gorgias-shaped). From
  the [connect any tool plan](2026-11-26-connect-any-tool.md): the detect step; Path B (an API key or no sign-in); the
  connection check; the client lookup order; the sign-in exceptions E1 to E12 and the renewal rule as table-driven
  fixture tests; plain failure reasons; the four sign-in flaws in `app/hub/oauth/` and `app/hub/signin/core.ts` (F1 to
  F4: a missing `token_type`, any 400 or 401 on renewal ending a login, an exact issuer match and errors sent with a
  success status, a missing or comma-separated `scope`); the Admin's credential step on a prepared connection (High
  tier: routes, the access matrix, `signin`, `crypto`); the connector kit and one built connector on a fixture API
  (Path C). Where a list or rule is carried over closely from Executor (the exceptions table, the reason list), the
  module's header comment names Executor and commit `d30f09c` and keeps Executor's copyright line and MIT notice.
  Then, optionally, the browser Worker (D8).
- **Done when:** a 2026-07-28-only fixture server and a 2025-11-25 one both connect by URL with no code change, and
  their reads work in chat, in a proactive check and from a code-mode script; a login reply with a wrong `iss` is refused; a changed tool
  definition hides the tool; an MCP write asks and goes through the outbox; Slack keeps working on the new client.
  Items 1 to 9 of the connect plan's acceptance checklist pass: six fixture addresses give the six detect outcomes
  with no redirect, credential or tool call; each of E1 to E12 gives its row's reaction; on renewal only
  `invalid_grant` ends a login (property test); every refusal shows a plain reason and the logs hold no secret; a key
  entered once works, is never returned, is refused if wrong and turns "Needs a new key" when revoked; the check is
  refused without the credential; the built connector works with no hub change, holds no key and treats an unmarked
  tool as a write; a Member can't connect and an Admin can only give the login on a prepared connection; a server with
  its own code mode is asked for plain tools. Browser (if built): its capability case passes; logins only by handoff.

### M5: Proactive mode

- **Goal (plain):** switch it on and the agent watches your tools, tells you what matters and handles what it's
  allowed to, inside a budget.
- **Adopts:** routines as the engine; Haiku for triage; the ledger's reservation pattern.
- **Builds:** the brand switch (default off) and quiet hours; the proactive pool with daily pace; schedule and poll
  signals; triage; the watchlist (agent proposes, admin accepts); findings with dedupe in Today; the morning brief;
  urgent notices; brand grants for background actions; Slack channel scope for unattended reads.
- **Done when:** off starts no background run (property test); an empty pool leaves chat working; a fixture issue
  yields one finding that updates in place; "nothing new" writes nothing; a brand grant lets a background run complete
  its bounded action and it shows in Activity with Undo.

### M6: Capability gate

- **Goal (plain):** proof that the agent finishes real work, not just that the wiring is right.
- **Adopts:** outcome grading with repeated trials.
- **Builds:** 12 to 15 multi-step tasks on fake data, graded on the end state: restock plan to a sheet to Slack; a
  returns investigation; tagging 40 orders must raise one batch card; a 2-hour analysis with subagents that survives a
  container kill; connect an MCP server by URL and use it; sourced web research.
- **Done when:** results committed; completion rate over 3 trials meets the target Wasim sets (proposal: 80% on Sonnet
  5.5), zero unapproved guarded writes, asks per task and cost reported; **one capped paid run** (D11).

### M7: Pack seam

- **Goal (plain):** Shopify becomes the first "costume" the core can wear, so a second sector needs no core changes.
- **Builds:** the pack manifest and loader; Shopify's operations, checks, prompt material, skills, card words and
  fixtures moved into `app/packs/ecommerce-shopify/`; a lint rule; a toy second pack. A tool many brands share that
  has no MCP server becomes a pack connector.
- **Done when:** core imports nothing from Shopify; both packs pass their evals.

## 8. Stage 2: Connection (paused)

Starts only on Wasim's word after Stage 1.
- House release of the built agent (`inhouse-ops` `house-release.yml`, `SHOPIFY_WEBHOOK_SECRETS` first).
- Live Shopify (read and write apps on the house test store) and Slack (test workspace, a background identity with
  bounded channel access).
- The public webhook route for Shopify events (Access exception, Wasim's decision) with Cloudflare Queues.
- Live sign-ins for real MCP servers the first brands use.

## 9. Stage 3: Proving it live (paused)

- The full paid eval sweep on every picker model (with the prompt fix).
- A soak on house with everything live (length set when it starts), including writes and proactive mode.
- House restore drill with the outbox held and reconciled; runbook rehearsals (pause, key rotation, member removal,
  teardown, rollback).
- Fresh-account install (standing decision 11 of the old plan still describes the reduced smoke).

## 10. After the build: operator tools

Inhouse's edge includes Wasim running each brand's agent. After M7: one place to see every brand's health, spend,
errors, agent quality (eval results, refusals, needs-a-check items) and grants, and a safe way to roll fixes and
improvements to each brand's account. Today this is spread across `inhouse-ops` workflows.

## 11. Standing decisions carried over

From the [2026-11-22 plan](../history/2026-11-22-master-plan.md):
- **5. Interface audience:** members and admins are non-technical to semi-technical; every screen shows outcomes in
  plain words, mechanics behind a "full trace" at most. Applies to every permission card and finding.
- **6. Brand skills**, **7. Team requests show status only**, **8. Routine run history**, **10. Export scope**: unchanged.
- **9. Eval timing** is replaced by D11 (paid runs at M3 and M6, full sweep in Stage 3).
- **1 to 4 and 11** were Watch-release decisions; 11's reduced fresh-account smoke carries into Stage 3.

## 12. Risks

- **Prompt injection with writes.** Untrusted orders, messages and tool results can try to trigger writes. Answer: the
  server decides, guardrails can't be granted away, every grant has limits, and M3's eval must show zero bypasses
  before any real write.
- **Background cost.** Waking the full agent on every check would burn the budget. Answer: free signals, triage before
  spend, daily pace, the pool.
- **Any-MCP trust.** Any address can be connected, so a server can be hostile. Answer: in M4 only the Inhouse team
  connects one (D6), tokens stay in the hub, tool text is untrusted, writes ask, definitions are pinned.
- **Second-hand sign-in exceptions.** E1 to E12 are Executor's reading of each service, and services change. Answer:
  fixture tests now, live sign-ins in Stage 2, and a re-scan of Executor's exceptions when a milestone touches sign-in.
- **The connector's guarded outbound call** is the least-proven part of Path C. Answer: M4's connector slice proves it
  first on a fixture, with the hub's existing no-network sandbox (`app/hub/codemode/`) as the fallback.
- **Engine coupling.** The Agent SDK's session store is still alpha. Answer: keep `RunConfig` and `SessionEvent` as
  the one engine seam so a later move (for example to Managed Agents at GA) isn't a rewrite.
- **Differentiation.** Answer: lean into the team, the brand's own account and the operator.

## 13. Sources

All primary sources, checked 2026-11-24 (WebFetch and Exa full-page reads); notes and quotes in
`verify/agent-direction/doc-check.md`.

- MCP 2026-07-28: [spec](https://modelcontextprotocol.io/specification/2026-07-28),
  [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
  [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
  [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
  [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
  [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
  [caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching).
- MCP TypeScript SDK: [releases](https://github.com/modelcontextprotocol/typescript-sdk/releases) (`@modelcontextprotocol/client` 2.4.0, 2026-10-23).
- Claude Agent SDK: [subagents](https://code.claude.com/docs/en/agent-sdk/subagents),
  [session storage](https://code.claude.com/docs/en/agent-sdk/session-storage),
  [hooks and defer](https://code.claude.com/docs/en/hooks), [tools reference](https://code.claude.com/docs/en/tools-reference).
- Claude Managed Agents: [overview](https://platform.claude.com/docs/en/managed-agents/overview).
- Cloudflare: [Browser Run](https://developers.cloudflare.com/browser-run/),
  [pricing](https://developers.cloudflare.com/browser-run/pricing/),
  [limits](https://developers.cloudflare.com/browser-run/limits/),
  [Playwright MCP](https://developers.cloudflare.com/browser-run/playwright/playwright-mcp/),
  [human in the loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/),
  [request headers](https://developers.cloudflare.com/browser-run/reference/automatic-request-headers/),
  [Queues delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
  [DO alarms](https://developers.cloudflare.com/durable-objects/api/alarms/),
  [Workflows retries](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/).
- Shopify: [Shopify MCP (coming soon)](https://shopify.dev/docs/api/shopify-mcp),
  [Next Gen Events GA](https://shopify.dev/changelog/blog/next-generation-events-are-now-generally-available),
  [webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries).
- Products: [Claude Duet](https://claude.com/resources/articles/claude-duet) (asks before messages, payments,
  signatures and deletions: [support](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)),
  [Claude connector tool permissions](https://support.claude.com/en/articles/11176164) (an org-admin control in
  Claude; ours adds member-level grants for their own chats),
  [Claude chat and Cowork merged](https://support.claude.com/en/articles/16761823),
  [OpenClaw heartbeat retired into automation jobs](https://docs.openclaw.ai/gateway/heartbeat).
- Connecting any tool (read 2026-11-26): Executor's source at commit `d30f09c` and its docs, `@modelcontextprotocol/sdk`
  1.32.1, and Cloudflare's remote MCP server, service binding and Containers pages; full list in the
  [connect any tool plan](2026-11-26-connect-any-tool.md), section 16.
