# P3: agent chat (`fleet/agent-chat`)

Status: locked and approved by Wasim, 2026-11-19. Phase plan under the backend plan
(`docs/plans/2026-11-19-backend.md`). Common rules are in its "Phase schedule (waves)" section. P0 records:
[S1](../decisions/p0-s1-runner.md), [S2](../decisions/p0-s2-container-guards.md),
[S3](../decisions/p0-s3-previews.md), [S5](../decisions/p0-s5-memory-tool-choice.md).

Progress: tracked in the backend plan's "Implementation progress" section, entry P3. Read it before you start
and update it before you stop.

## Goal

The Inhouse agent answers in a real chat: the runner in containers under the guards, live runs in the BrandAgent
object, streaming with reattach, chat history on the server, usage under the cap, memory and history tools, and the
first agent evals.

**Success measure (the real slice):** ask a question, watch it stream, reload mid-answer and pick it up.

## Scope

In, in two tracks:
- **Runner track (R), from wave 0:** the container image and the runner (Node plus the Claude Agent SDK) with every P0
  rule; the session process contract (a root runner, one process per session as its own OS user); the run-token proxy;
  the guards (sandbox mandatory, the `stubs` folder layout, `.claude/` read-only, locked tools and skills, blocking
  audit hook, WebFetch domain list); the session store on R2 with the checkpoint and repair;
  `sessionStoreFlush: 'eager'` tested against a hard kill; saving the files a run makes; SIGTERM handling; the
  Worker-runner protocol version; the scripted model; the guard probe tests from S2; the re-check of the four built-in
  tools that didn't register headless; S1's open items (memory readout without the cgroup files, cold start after long
  idles).
- **Chat track (C), wave 3:** the BrandAgent Durable Object with its due-task scheduler; Pause for new and live runs;
  the runner pool (standard-4, `max(2, ceil(peak / 25))`, fill-first, placement-refusal routing, a brief queue, the
  inactivity timeout set on every run, the shortfall signal); the egress entrypoint with the per-run token table and
  its four scoped routes (model, `inhouse` MCP, session store, files); the AI Gateway with payload logging off; the
  model and effort per model from Settings, and `maxTurns`; usage and the cap, with the Usage page and the cap alert;
  **C4** chat history and chat management (rename, pin, delete, restore); **C5** streaming and reattach; chat
  attachments; the `inhouse` MCP server with all 20 tool definitions and the memory and history tools built; the
  Memory pages' API; the daily audit copy to R2; drain and warm-up on deploy; the run and pool health signals; the
  eval harness seeded from S5 and the first exfiltration cases; the nightly guard tests; API specs for the new routes
  and the socket.

Out: routines, Today and connectors (P4, P5); approvals, `question_ask`, team requests and skills of our own (P6); the
Bedrock switch (P8, Wasim's decision Q5). Tools not built here return a typed "not available yet" until their phase.

## Inputs and gates

- Runner track: Wasim's wave 0 development key with a spend limit for its few real-model checks; everything else uses
  the scripted model. It starts in wave 0, beside hardening, and puts PRs only into this branch (see the schedule).
- **Spike S6, wave 0 (orchestrator):** one chat under `wrangler dev` with the SDK sandbox on and one OS user per
  session, on the Mac, on a GitHub runner and beside the ship job's Playwright container. Every P0 spike ran deployed,
  and Cloudflare's local-dev docs say non-root users get no Linux capabilities locally. Record:
  `docs/decisions/p3-local-containers.md`. If the sandbox can't start locally, the test path is Wasim's decision Q2
  (schedule); tests never run with the sandbox off.
- Chat track: P2 merged into `main` (Access, members, D1, the test build, the real client).
- **From Wasim before the chat track:** our Anthropic key in the house deployment's AI Gateway (he adds it himself), a
  spend limit for P3's model calls, and OK for the paid eval runs (the `evals` skill).
- **The guard on agents' model calls.** Agents aren't allowed to call the AI Gateway yet; Wasim opens that when the
  chat track needs it. Until then no worker runs a check through the gateway.
- **Asked of Cloudflare, not blocking:** how `max_instances` relates to placement near a brand's Durable Objects.
  Without an answer, the pool ships with `max_instances` at 3 times the need and the shortfall alert.
- **Gate at the end of P3 (Wasim):** the product model, chosen on the eval suite's results (decision log, "P0
  models").
- **Test model (Wasim, 2026-11-19):** every test, eval, smoke or check in this phase that calls a real model runs on
  Sonnet 5.5 (`claude-sonnet-5-5`) at medium effort; everything else uses the scripted model. The one exception is the
  product model comparison at the end of P3, which runs the candidates side by side.

## Design notes

- **Layout.** `app/runner/` (its own `package.json`, `Dockerfile`, `src/`, `test/`, and a small `harness/` Worker for
  running the runner under `wrangler dev` before P2's server exists). Server pieces under `app/server/do/`,
  `app/server/egress/`, `app/server/model/`, `app/server/usage/`, `app/server/mcp/`, `app/server/files-io/`.
- **Protocol.** `app/shared/protocol/` holds the zod schemas for Worker-runner messages and the version constant; the
  Worker accepts the current and previous version. Run events for the browser carry their own protocol version (C5).
  The runner's build bundles this folder with zod resolved from the runner's own `node_modules`, the Docker build
  context includes `app/shared/`, and a script checks `app/` and `app/runner/` pin the same zod major.
- **The session process contract** is R1's first PR, because R2's guards wrap it. A root runner process owns the
  server, the protocol and every run token. Each session runs `query()` in its own process as its own OS user, started
  by the root runner, and talks to it over a local channel.
- **Where the run token lives.** Only in the root runner's memory. A session's process, the CLI and Bash never hold
  it: the model base URL, the `inhouse` MCP URL, the session store adapter and file saves all point at a loopback
  proxy in the root runner. The proxy knows which session is calling from the caller's OS user and adds that run's
  token. So a token never sits in an environment variable, a command line, an MCP config file or the CLI's settings,
  where same-user Bash could read it. R1 confirms in the SDK docs how the base URL and MCP servers are passed. R2's
  probes cover `/proc/*/environ`, `/proc/*/cmdline`, the MCP config and the settings files.
- **Egress routes, each scoped by the run token.** The egress entrypoint checks the token against the BrandAgent
  object's per-run table, then allows four things: the model; the `inhouse` MCP server, as that run's person; the
  session store, for that run's chat only; file reads and saves, for that run's chat only. A token can't read another
  chat's transcript or files, which is what keeps the per-session OS user meaningful.
- **Files a run makes.** The 20 tools have no file tool. The agent writes results into `outputs/` in its working
  folder. When a turn ends the runner saves each new or changed file there through the files route: a size cap per
  file, a count cap per turn, types by magic bytes, anything else refused with a notice in the chat. A person's
  attachments arrive in `inputs/`. A fresh container starts with an empty disk: on resume the runner restores the
  chat's attachments and saved files from R2 up to a size cap and tells the agent which ones it left out. Downloads
  go through the Worker with a permission check, as attachments, with `nosniff` and `Content-Security-Policy:
  sandbox`; HTML and SVG never render in the app's origin.
- **One writer per chat.** The BrandAgent object runs one turn at a time per chat. A `send` from a second tab while a
  turn runs joins that run by its priority; it never starts a second writer. Every event has a `seq`; the client drops
  a `seq` it has seen and re-attaches from its last `seq` when it sees a gap, so the handoff from replay to live can't
  double or lose a part.
- **Authority ends on a timer too.** Removing a member or ending a grant by hand closes sockets at once. A grant's
  expiry is a due task that does the same, so access doesn't outlive the grant until someone presses a button. The
  socket upgrade gets P2's JWT and `Origin` checks.
- **One alarm, many jobs.** The BrandAgent object keeps a due-task table in its storage and a handler registry. The
  alarm runs every due task through its handler once (each handler idempotent, keyed by its task id) and sets the next
  alarm. Later phases register handlers in their own files (routine slots, the send hold and sweep, retention, backups);
  this phase registers the audit copy and grant expiry.
- **The runner track merges into this branch early.** It never touches `app/src/`, `app/server/` or shared configs
  other than `app/shared/protocol/`, so it runs while hardening, P1 and P2 are open. A runner job in this branch's
  `ci.yml` (types, tests, the image build) keeps `ci` honest about it. The harness is deleted once the real runner
  objects carry the runner tests.
- **Image builds.** Building the container image needs Docker. On the Mac only the orchestrator starts Docker, under
  the heavy lock; workers can't. So R1 and R2 run types and unit tests locally and get the image build and the
  container tests from CI's runner job, or from the orchestrator on request.
- **Test path.** Per the schedule's rule and S6's result: the QA gate and the ship recording run on the test build
  under `wrangler dev` with the scripted model; the house deployment gets a real-model smoke after release, never the
  scripted model.
- **Scripted model.** A fake Anthropic endpoint (`app/test/scripted-model/`), keyed by scenario and turn; a miss fails
  the test. Test builds only; its canary joins the product build check's server scan.
- **All 20 tools registered.** The `inhouse` server registers all 20 definitions from the approved tool list with
  their real names, descriptions and the 6 always-loaded and 14 on-demand split, so evals see the real tool set. The
  memory and history tools are built here; the others return a typed "not available yet" until their phase builds
  them. The registry file `app/server/mcp/registry.ts` is orchestrator only; each tool's handler is its owner's file.
- **Built-in tools: configured and observed are two checks.** The config test asserts the `tools` list is exactly the
  decided 20. The probe records which of them register headless and asserts nothing outside the 20 does. S2 didn't
  prove all 20 register, so the four that didn't are re-checked with the real `inhouse` server and the result written
  down, not assumed.
- **WebFetch.** Its domain list is a technical setting per brand, empty by default, so WebFetch reaches nothing until
  the Inhouse team lists a domain.
- **Models.** The server refuses a run on a model an admin switched off, whatever the picker sent. A session records
  its provider when it's created and a resume on another provider is refused (BD9), so no later switch can replay a
  half-done run elsewhere.
- **Usage for a run with no result.** The egress entrypoint sees every model response, so it keeps a usage tally per
  run and the Worker settles from it. That replaces the gateway's request log in the backend plan's Architecture 10:
  the test build has no gateway, and the Worker needs no gateway API token.
- **Memory prompt rule:** the softer rule (decision log, 2026-11-19): search memory when the question could depend on
  saved context. The eval checks recall doesn't drop. Prompts live in `app/server/prompt/` (orchestrator only).
- **Signals and the registry.** W1 and W2 add their health signals as files under `app/server/ops/signals/`. Every
  migration PR adds its table registry entry (`app/ops/tables/<resource>.ts`).

## Workers

The orchestrator (Opus) writes the design into the brief of every sensitive worker (R1, R2, W1 to W4). In wave 3 at
most 5 P3 workers run at once, the runner track included.

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| R1 | opus-worker (Opus 5.5, medium), sensitive: concurrency | First PR: the session process contract (root runner, one process per session, the local channel) and the protocol schemas. Then the run lifecycle: the server, one `query()` per run with `settingSources: []` and auto memory off, model, effort and `maxTurns` from the run config, `process.report.excludeNetwork = true` before the SDK loads, stable working folders with `inputs/` and `outputs/`, `sessionId` and `resume`, the `""` resume prompt, the run-token proxy, the session store adapter with the checkpoint and repair, `mirror_error`, eager flush against a hard kill, saving `outputs/` and restoring files on resume, SIGTERM with `interrupt()` then flush, the protocol handshake, memory readout without cgroup files; the scripted model endpoint; the harness. | `app/runner/src/{server,session,run,store,protocol,proxy,files}/**`, `app/runner/test/{run,store,protocol,proxy,files}/**`, `app/runner/harness/**`, `app/shared/protocol/**`, `app/runner/package.json`, `app/test/scripted-model/**` | R0 |
| R2 | opus-worker (Opus 5.5, medium), sensitive: guards | The guards around R1's session process: one OS user per session, the 0755 work root and `stubs` session layout, SDK sandbox (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`), the tools lock (the decided 20), the skills lock (`dataviz` plus ours, overrides and plugins off), skills through `plugins` from a read-only path, the blocking audit hook, the WebFetch list from the run config; the S2 probe set as tests, with the token probes above; the four-tool re-check with a `canUseTool` callback; cold start after a long idle measured; the Dockerfile. | `app/runner/src/guards/**`, `app/runner/test/guards/**`, `app/runner/Dockerfile` | R0; R1's first PR |
| W1 | opus-worker (Opus 5.5, medium), sensitive: concurrency | First PR: the run, chat and event contract files, the run token table's interface, the due-task scheduler and handler registry (W4, W5, W6 and P8's groundwork wait on these). Then the BrandAgent object: runs and turns, one writer per chat, the event log with `seq` in SQLite, WebSocket fan-out with hibernation and the checked upgrade, `attach(runId, fromSeq)`, `send`, `interrupt` and `stop` by turn id, the per-brand concurrent-run limit, Pause for new and live runs, session naming and the session's provider, socket close on member removal, grant end and grant expiry, finished messages to D1, chat rename, pin, delete and restore; the run-failure, stuck-run and `mirror_error` signals; the chat and run migrations. | `app/server/do/brand-agent/**`, `app/server/api/{runs,chats,pause}.ts`, `app/shared/contract/{runs,chats}.ts`, `app/server/ops/signals/runs.ts`, migrations in `0100`-`0199` for its tables | P2 merged |
| W2 | opus-worker (Opus 5.5, medium), sensitive: concurrency | Runner pool: runner Durable Objects with `ctx.container`, fill-first routing, placement refusal as a normal outcome, a short queue when all are full, the inactivity timeout on every run, the protocol version check, the container-restart and shortfall signals, the drain and warm-up routes for deploys. | `app/server/do/runner/**`, `app/server/ops/{drain,warmup}.ts`, `app/server/ops/signals/pool.ts` | P2 merged; R1's protocol |
| W3 | opus-worker (Opus 5.5, medium), sensitive: secrets | Egress entrypoint: pinned upstreams, request and redirect validation, credentials added at the edge, run tokens checked against W1's table (never carried in intercept props), the four scoped routes (model, `inhouse` MCP, session store, files) and the per-run usage tally; the AI Gateway route with the brand key and payload logging off; wiring the scripted model into test builds only; file saves, attachment uploads and safe downloads on R2, with the files table. | `app/server/egress/**`, `app/server/model/**`, `app/server/files-io/**`, `app/server/api/attachments.ts`, `app/shared/contract/attachments.ts`, migrations in `0100`-`0199` for its tables | P2 merged; W1's first PR |
| W4 | opus-worker (Opus 5.5, medium), sensitive: money | Usage and the cap: the D1 reservation with one conditional update, `maxBudgetUsd` from it, idempotent settle deltas, settle from W3's tally for a run with no result, `cap_reached`, the alert threshold; the Usage page and the Spending cap page on real numbers, with their client; the daily audit copy to R2 as a scheduler handler; the usage migrations. | `app/server/usage/**`, `app/server/audit-copy.ts`, `app/shared/contract/usage.ts`, `src/agent/http/usage.ts`, `src/screens/Usage.tsx`, migrations in `0100`-`0199` for its tables | W1's first PR |
| W5 | sonnet-worker (Sonnet 5.5, medium) | C4 and C5 on the mock, the UI and the real client: `listChats()`, `getChat(id)`, rename, pin, delete and restore, drafts and view choices only in the browser; events with `seq`, `turnId`, `messageId` and protocol version, dropped when seen and re-attached on a gap; `activeRuns()`, `attach`; `send` returns a `turnId` and carries attachments; async `getTrace`; the WebSocket client with reattach and a reload prompt for an unreadable version; `pause()` and `resume()` on the real client; the model picker sending the chosen model; the Models and Inhouse agent pages on server values. Mock and settings-pages owner for this phase (W4 and W6 hand their settings changes here). | `src/agent/mock.ts`, `src/agent/http/stream/**`, `src/agent/http/{chats,runs,pause,attachments}.ts`, `src/screens/chat/**`, `src/screens/Chats.tsx`, `src/overlays/TraceWindow.tsx`, `src/components/Composer.tsx`, the chat slice of `src/state/store.ts`, `src/screens/settings/content.ts`, `src/screens/Settings.tsx` | P2 merged; W1's first PR |
| W6 | sonnet-worker (Sonnet 5.5, medium) | The `inhouse` MCP server on the Worker over D1, called through W3's route as the run's person: all 20 definitions registered, the memory tools (search, save, update, forget, list; `memory_save` refuses customer personal data; brand facts wait for an admin, person facts count at once) and the history tools on FTS5; the Memory and Team memory pages' API and client (`forgetMemory`, the lists); the memory migrations. | `app/server/mcp/{server,tools/memory,tools/history,tools/stubs}/**`, `app/server/api/memory.ts`, `app/shared/contract/memory.ts`, `src/agent/http/memory.ts`, migrations in `0100`-`0199` for its tables | P2 merged; W1's first PR |
| W7 | sonnet-worker (Sonnet 5.5, medium) | The eval harness from S5 (43 cases, the code-only grader with its three fixes, recall, tool choice, cost per conversation), results kept per the `evals` skill; the exfiltration cases that already apply (WebFetch to an unlisted domain, a link or image in an answer that carries data out, tool data that tells the agent to save a fact about a person); the scripts the nightly workflow calls; the contract suite's real target for the P3 methods; API specs for the runs, chats, pause, usage, memory and attachment routes, the socket's 401 and `Origin` check, revocation and grant expiry closing a socket, a run token refused on another chat's session and files, two tabs sending into one chat, and a reconnect during the replay-to-live handoff. | `app/evals/**`, `app/scripts/nightly/**`, `src/agent/contract/targets/real/chat.ts`, `app/e2e/api/{runs,chats,pause,usage,memory,attachments,socket,egress}.spec.ts` | R2's probes, W1, W3, W6 |

## Orchestrator only

- R0, the runner track's PR0: the `app/runner/` skeleton, the zod-major check script, and the runner job in this
  branch's `.github/workflows/ci.yml` (types, tests, image build; no secret).
- Spike S6 and its record.
- `app/server/routes.ts`, `app/server/access-matrix.ts`, `app/server/mcp/registry.ts`,
  `app/server/ops/signals/index.ts`, `app/ops/tables/index.ts`, `src/agent/http/index.ts`,
  `src/agent/contract/targets/real/index.ts`, `app/server/prompt/**` (the system prompt with the softer memory rule,
  with eval results), `app/wrangler.product.jsonc` (Durable Object classes, containers, R2, AI Gateway binding;
  classes only ever added), `app/package.json` and lockfiles, `app/shared/contract/index.ts`, `vite.config.ts`,
  `playwright.config.ts`, the test build's config, `app/scripts/check-product-build.mjs` (the scripted model's
  canary).
- `.github/workflows/ci.yml` (container tests under `wrangler dev`, on the branch), `.github/workflows/nightly.yml`
  (bootstrap PR into `main`; house credentials only in its environment; it runs `main`'s code against the house
  deployment), `.github/workflows/ship.yml` (the container mode of P2's test-build run, bootstrap PR).
- The release step, after the merge: drain, deploy the tag with `--containers-rollout=immediate`, warm-up, then the
  real-model smoke on the house deployment as the `smoke` principal (one question; it writes only that principal's
  own chat).
- `AGENTS.md`, `verify` skill, feature map, `e2e/ship/agent-chat.spec.ts`, the eval results write-up.

## Order and parallelism

1. Wave 0: R0, then R1's first PR (the session process contract), then R1 and R2 in parallel on `fleet/agent-chat`
   cut from `main`, against the harness. S6 runs as soon as R1's contract and R2's sandbox config exist.
2. Waves 1 and 2: the runner track continues. `main` merges in after hardening, P1 and P2.
3. Wave 3, when P2 merges: W1's first PR (contracts, token table interface, scheduler and registry). Then W1, W2, W3
   in parallel with the runner track's tail (5 at once in total).
4. As seats free: W5 and W6, then W4. All three need only W1's first PR.
5. W7 once R2's probes, W1, W3 and W6 merge; the nightly and ship workflow changes go into `main` as bootstrap PRs.
6. The harness is deleted.
7. Eval baseline run, then Wasim's model choice; its config lands before the final PR.

## Browser scenarios (`e2e/ship/agent-chat.spec.ts`, desktop and phone, test build, scripted model)

- S1: Ask a question on Today and watch the answer stream into a new chat.
- S2: Reload mid-answer; the chat picks up where it was with no lost or doubled part.
- S3: A second tab on the same chat shows the same stream; a message sent from it joins the same run.
- S4: Stop mid-answer stops that turn only; a follow-up sent while it runs acts on the right turn.
- S5: All chats lists the server's chats; an old chat opens after a reload with its full history; rename and pin
  survive a reload.
- S6: A second Member can't see the first person's chat.
- S7: Memory: "remember I like order tables sorted by date", then a new chat uses it. "Remember we restock on Fridays"
  shows as waiting for an admin and a new chat doesn't rely on it.
- S8: Pause the agent; a new question is refused with a notice and a live answer stops; resume.
- S9: At the cap, a new question gets the cap notice and Usage shows the cap reached.
- S10: Attach a file to a question; the agent makes a spreadsheet from it; the file shows in the chat and downloads.

## Acceptance

1. A run streams to two tabs; a reload mid-answer reattaches from its `seq` with no lost or doubled part; `send`,
   `interrupt` and `stop` act on the right turn by id; two tabs sending into one chat produce one writer and one
   ordered stream; a reconnect during the replay-to-live handoff neither doubles nor drops a part.
2. The socket returns 401 without a valid JWT and refuses a wrong `Origin`; removing a member, ending a support grant
   or a grant's expiry closes their sockets and ends their runs' authority.
3. The contract suite passes on the mock and the real client for C4 and C5; fast-check covers reattach ordering.
4. A deferred call and a resume survive a container restart; a dropped mirror batch is repaired before a chat is
   marked waiting; eager flush is proven against a hard kill, or the gap is recorded and the person is told.
5. Every S2 probe passes in the nightly run: hosts outside the allowlist fail, no secret or token is reachable from
   Bash (the sandbox's own allowlist-proxy credential is the only one allowed, and no run token is in a process
   environment, command line, MCP config or settings file), one session can't read another's folder, a failing audit
   hook stops the call, `.claude/` isn't writable.
6. A run token reaches only its own chat's session and files: the same call with another chat's id is refused at the
   egress, and the refusal is logged.
7. The configured built-in tool list is exactly the decided 20 (a config test). The observed headless registrations
   are recorded, nothing outside the 20 registers, and the four tools that didn't register in P0 are checked with the
   real server. All 20 `inhouse` definitions are registered with the agreed split.
8. The scheduler runs each due task once when the alarm fires twice (tested), and the audit copy lands in R2 daily.
9. Pause stops new runs and live runs; resuming starts nothing on its own.
10. At the cap new runs get `cap_reached`; concurrent runs overshoot by at most one response each; resumed and crashed
    runs settle once, a run with no result from the egress tally; Usage matches the D1 ledger.
11. Runs fill one container before waking the next; a placement refusal routes to a running container or queues; a
    lasting shortfall raises the signal. The health route reports run failures, stuck runs, `mirror_error`, container
    restarts and the shortfall.
12. A Worker one protocol version ahead of its runner still runs chats; a deploy drains, rolls out and warms up with no
    failed run.
13. The chosen model and its effort from Settings reach `query()`; a switched-off model is refused by the server;
    `maxTurns` is set on every run; WebFetch reaches only the brand's listed domains and nothing when the list is
    empty.
14. A file the agent wrote to `outputs/` is saved within the caps and downloads only as an attachment with `nosniff`
    and a sandboxing CSP; an oversized or disallowed file is refused with a notice; a resume in a fresh container
    restores the chat's files.
15. The eval suite has a recorded baseline (tool choice, recall, cost per conversation); recall doesn't drop under the
    softer memory rule; the first exfiltration cases have zero bypasses; Wasim chose the product model.
16. API specs pass for every new route and the socket.
17. The product and server bundles contain no scripted model; the demo is unchanged.
18. QA PASS and the ship recording on S1 to S10; after the release, the real-model smoke passes on the house
    deployment.

## Must not

No secret, model key or tool token inside the container or in a log; no run token on `/api/*`, in a session's process
or in a tool subprocess's environment; no tool write path from the runner; no test with the sandbox off; no deprecated
`Container` class; no beta scheduling policy or snapshots; no scripted model in a deployed build; no preview pointed at
the house runner; no automatic replay of a half-done run; no second alarm owner in the BrandAgent object; no build that
calls a real model released without the cap; no retries in tests; no paid eval run without Wasim's OK.

## Risks

- The Agent SDK is 0.x and its behaviour runs ahead of its docs (P0). Pin it; evals on every bump.
- The sandbox under `wrangler dev` is unproven (S6). The test path for every later phase hangs on it, which is why it
  runs in wave 0.
- Container placement: refusals are normal, capacity grew over a new app's first 30 minutes, `max_instances` vs
  placement is undocumented. Route around refusals, alert on a shortfall, ask Cloudflare.
- Eager flush is alpha; if it fails, the accepted gap stands and is shown to the person.
- The chat track is the largest piece of the backend. If it runs long, split worker PRs, never the release: chat
  doesn't ship to the house deployment without the reservation, the settle and the cap.

## How it lands

- Branch `fleet/agent-chat` from `main` at the runner track's start (wave 0); `main` merges in after hardening, P1 and
  P2.
- Review rows: R1, R2, W1 to W4 and every migration at Sonnet plus Opus high (concurrency, secrets, money, schema);
  W5, W6, W7 Sonnet plus Opus medium; the nightly and ship workflow bootstrap PRs at high (secrets).
- Final PR with the full ship gate on the test build. After merge, the orchestrator releases the tag to the house
  deployment with drain and warm-up, with Wasim's OK, and runs the real-model smoke.
