# P3: agent chat (`fleet/agent-chat`)

Status: draft, 2026-11-19, revised after the Sonnet and Opus review. Phase plan under the backend plan
(`docs/plans/2026-11-19-backend.md`). Common rules are in its "Phase schedule (waves)" section. P0 records:
[S1](../decisions/p0-s1-runner.md), [S2](../decisions/p0-s2-container-guards.md),
[S3](../decisions/p0-s3-previews.md), [S5](../decisions/p0-s5-memory-tool-choice.md).

## Goal

The Inhouse agent answers in a real chat: the runner in containers under the guards, live runs in the BrandAgent
object, streaming with reattach, chat history on the server, usage under the cap, memory and history tools, and the
first agent evals.

**Success measure (the real slice):** ask a question, watch it stream, reload mid-answer and pick it up.

## Scope

In, in two tracks:
- **Runner track (R):** the container image and the runner (Node plus the Claude Agent SDK) with every P0 rule; the
  guards (sandbox mandatory, one OS user per session, the `stubs` folder layout, `.claude/` read-only, locked tools and
  skills, blocking audit hook, WebFetch domain list); the session store on R2 with the checkpoint and repair;
  `sessionStoreFlush: 'eager'` tested against a hard kill; SIGTERM handling; the Worker-runner protocol version; the
  scripted model; the guard probe tests from S2; the re-check of the four built-in tools that didn't register headless;
  S1's open items (memory readout without the cgroup files, cold start after long idles).
- **Chat track (C):** the BrandAgent Durable Object with its due-task scheduler; Pause for new and live runs; the
  runner pool (standard-4, `max(2, ceil(peak / 25))`, fill-first, placement-refusal routing, a brief queue, the
  inactivity timeout set on every run, the shortfall signal); the egress entrypoint with the per-run token table and
  the file-save route; the AI Gateway with payload logging off; the model and effort per model from Settings, and
  `maxTurns`; usage and the cap, with the Usage page and the cap alert; **C4** chat history; **C5** streaming and
  reattach; the `inhouse` MCP server with all 20 tool definitions and the memory and history tools built; the daily
  audit copy to R2; drain and warm-up on deploy; the eval harness seeded from S5; the nightly guard tests; API specs for
  the new routes and the socket.

Out: routines, Today and connectors (P4, P5); approvals, `question_ask`, team requests and skills of our own (P6); the
Bedrock switch (P8). Tools not built here return a typed "not available yet" until their phase.

## Inputs and gates

- Runner track: Wasim's wave 1 development key with a spend limit for its few real-model checks; everything else uses
  the scripted model. It starts in wave 1 (see the schedule).
- Chat track: P2 merged into `main` (Access, members, D1, previews, the real client).
- **From Wasim before the chat track:** our Anthropic key in the house deployment's AI Gateway (he adds it himself), a
  spend limit for P3's model calls, and OK for the paid eval runs (the `evals` skill).
- **Asked of Cloudflare, not blocking:** how `max_instances` relates to placement near a brand's Durable Objects.
  Without an answer, the pool ships with `max_instances` at 3 times the need and the shortfall alert.
- **Gate at the end of P3 (Wasim):** the product model, chosen on the eval suite's results (decision log, "P0
  models").
- **Test model (Wasim, 2026-11-19):** every test, eval, smoke or check in this phase that calls a real model runs on
  Sonnet 5.5 (`claude-sonnet-5-5`) at medium effort; everything else uses the scripted model. The one exception is the product model
  comparison at the end of P3, which runs the candidates side by side.

## Design notes

- **Layout.** `app/runner/` (its own `package.json`, `Dockerfile`, `src/`, `test/`, and a small `harness/` Worker for
  running the runner under `wrangler dev` before P2's server exists). Server pieces under `app/server/do/`,
  `app/server/egress/`, `app/server/model/`, `app/server/usage/`, `app/server/mcp/`.
- **Protocol.** `app/shared/protocol/` holds the zod schemas for Worker-runner messages and the version constant; the
  Worker accepts the current and previous version. Run events for the browser carry their own protocol version (C5).
- **One alarm, many jobs.** The BrandAgent object keeps a due-task table in its storage and a handler registry. The
  alarm runs every due task through its handler once (each handler idempotent, keyed by its task id) and sets the next
  alarm. Later phases register handlers in their own files (routine slots, the send hold and sweep, retention, backups);
  this phase registers the audit copy.
- **The runner track merges into this branch early.** It never touches `app/src/`, `app/server/` or shared configs
  other than `app/shared/protocol/`, so it runs while P1 and P2 are open. The harness is deleted once the real runner
  objects carry the runner tests.
- **Test path.** Per the schedule's rule: until containers start in Previews, the QA gate and the ship recording run
  on the test build under `wrangler dev` with the scripted model; the house deployment gets a real-model smoke after
  release, never the scripted model.
- **Scripted model.** A fake Anthropic endpoint (`app/test/scripted-model/`), keyed by scenario and turn; a miss fails
  the test. Test builds only; it gets a canary in P1's product build check.
- **All 20 tools registered.** The `inhouse` server registers all 20 definitions from the approved tool list with
  their real names, descriptions and the 6 always-loaded and 14 on-demand split, so evals see the real tool set. The
  memory and history tools are built here; the others return a typed "not available yet" until their phase builds
  them. The registry file `app/server/mcp/registry.ts` is orchestrator only; each tool's handler is its owner's file.
- **Memory prompt rule:** the softer rule (decision log, 2026-11-19): search memory when the question could depend on
  saved context. The eval checks recall doesn't drop. Prompts live in `app/server/prompt/` (orchestrator only).

## Workers

The orchestrator (Opus) writes the design into the brief of every sensitive worker (R1, R2, W1 to W4). In wave 3 at
most 5 P3 workers run at once, the runner track included.

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| R1 | opus-worker (Opus 5.5, medium), sensitive: concurrency | The runner's run lifecycle: the server, one `query()` per run with `settingSources: []` and auto memory off, model, effort and `maxTurns` from the run config, `process.report.excludeNetwork = true` before the SDK loads, stable working folders, `sessionId` and `resume`, the `""` resume prompt, the session store adapter with the checkpoint and repair, `mirror_error`, eager flush against a hard kill, SIGTERM with `interrupt()` then flush, the protocol handshake, memory readout without cgroup files; the scripted model endpoint. | `app/runner/src/{server,run,store,protocol}/**`, `app/shared/protocol/**`, `app/runner/package.json`, `app/test/scripted-model/**` | none |
| R2 | opus-worker (Opus 5.5, medium), sensitive: guards | The guards: root runner spawning one OS user per session, the 0755 work root and `stubs` session layout, SDK sandbox (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`), the tools lock (the decided 20), the skills lock (`dataviz` plus ours, overrides and plugins off), skills through `plugins` from a read-only path, the blocking audit hook, the WebFetch list; the S2 probe set as tests; the four-tool re-check with a `canUseTool` callback; cold start after a long idle measured; the Dockerfile. | `app/runner/src/guards/**`, `app/runner/Dockerfile`, `app/runner/test/**`, `app/runner/harness/**` | none |
| W1 | opus-worker (Opus 5.5, medium), sensitive: concurrency | BrandAgent object: runs and turns, the event log with `seq` in SQLite, WebSocket fan-out with hibernation and the Access-checked upgrade, `attach(runId, fromSeq)`, `send`, `interrupt` and `stop` by turn id, the per-brand concurrent-run limit, Pause for new and live runs, session naming, the run token table, socket close on member removal or grant end, finished messages to D1, the due-task scheduler and handler registry; the chat and run migrations. | `app/server/do/brand-agent/**`, `app/server/api/{runs,chats,pause}.ts`, `app/shared/contract/{runs,chats}.ts`, migrations in `0100`-`0199` for its tables | P2 merged |
| W2 | opus-worker (Opus 5.5, medium), sensitive: concurrency | Runner pool: runner Durable Objects with `ctx.container`, fill-first routing, placement refusal as a normal outcome, a short queue when all are full, the inactivity timeout on every run, the protocol version check, the shortfall signal, the drain and warm-up routes for deploys. | `app/server/do/runner/**`, `app/server/ops/{drain,warmup}.ts` | P2 merged; R1's protocol |
| W3 | opus-worker (Opus 5.5, medium), sensitive: secrets | Egress entrypoint: pinned upstreams, request and redirect validation, credentials added at the edge, run tokens checked against W1's table (never carried in intercept props), the file-save route to R2; the AI Gateway route with the brand key and payload logging off; wiring the scripted model into test builds only. | `app/server/egress/**`, `app/server/model/**` | P2 merged |
| W4 | opus-worker (Opus 5.5, medium), sensitive: money | Usage and the cap: the D1 reservation with one conditional update, `maxBudgetUsd` from it, idempotent settle deltas, settle from the gateway log for a run with no result, `cap_reached`, the alert threshold; the Usage page and the Spending cap page on real numbers; the daily audit copy to R2 as a scheduler handler; the usage migrations. | `app/server/usage/**`, `app/server/audit-copy.ts`, `app/shared/contract/usage.ts`, `src/screens/Usage.tsx`, migrations in `0100`-`0199` for its tables | W1's run registry and scheduler |
| W5 | sonnet-worker (Sonnet 5.5, medium) | C4 and C5 on the mock, the UI and the real client: `listChats()`, `getChat(id)`, drafts and view choices only in the browser; events with `seq`, `turnId`, `messageId` and protocol version; `activeRuns()`, `attach`; `send` returns a `turnId`; async `getTrace`; the WebSocket client with reattach and a reload prompt for an unreadable version; `pause()` and `resume()` on the real client; the model picker sending the chosen model. Mock and settings-pages owner for this phase (W4 hands its Spending cap page changes here). | `src/agent/mock.ts`, `src/agent/http/stream/**`, `src/agent/http/{chats,runs,pause}.ts`, `src/screens/chat/**`, `src/screens/Chats.tsx`, `src/overlays/TraceWindow.tsx`, `src/components/Composer.tsx`, the chat slice of `src/state/store.ts`, `src/screens/settings/content.ts`, `src/screens/Settings.tsx` | P2 merged; W1's contract files |
| W6 | sonnet-worker (Sonnet 5.5, medium) | The `inhouse` MCP server on the Worker over D1: all 20 definitions registered, the memory tools (search, save, update, forget, list; `memory_save` refuses customer personal data; brand facts wait for an admin, person facts count at once) and the history tools on FTS5; the memory migrations. | `app/server/mcp/{server,tools/memory,tools/history,tools/stubs}/**`, migrations in `0100`-`0199` for its tables | P2 merged |
| W7 | sonnet-worker (Sonnet 5.5, medium) | The eval harness from S5 (43 cases, the code-only grader with its three fixes, recall, tool choice, cost per conversation), results kept per the `evals` skill, and the scripts the nightly workflow calls; API specs for the runs, chats, pause and usage routes, the socket's 401, and revocation closing a socket. | `app/evals/**`, `app/scripts/nightly/**`, `app/e2e/api/{runs,chats,pause,usage,socket}.spec.ts` | R2's probes, W1, W6 |

## Orchestrator only

- `app/server/routes.ts`, `app/server/mcp/registry.ts`, `app/server/prompt/**` (the system prompt with the softer memory
  rule, with eval results), `app/wrangler.product.jsonc` (Durable Object classes, containers, R2, AI Gateway binding;
  classes only ever added), `app/package.json` and lockfiles, `app/shared/contract/index.ts`, `vite.config.ts`,
  `playwright.config.ts`, the test build's config.
- `.github/workflows/ci.yml` (container tests under `wrangler dev`), `.github/workflows/nightly.yml` (bootstrap PR into
  `main`; house credentials only in its environment), `.github/workflows/ship.yml` (the `wrangler dev` test-build mode
  for container phases, bootstrap PR).
- P1's product build check gets the scripted model's canary.
- The release step: drain, deploy with `--containers-rollout=immediate`, warm-up, then the real-model smoke on the
  house deployment.
- `AGENTS.md`, `verify` skill, feature map, `e2e/ship/agent-chat.spec.ts`, the eval results write-up.

## Order and parallelism

1. Wave 1 and 2: R1 and R2 on `fleet/agent-chat` cut from `main`, against the harness.
2. When P2 merges: `main` into the branch; W1, W2, W3 in parallel with the runner track's tail (5 at once in total).
3. When W1's contract files and registry land: W5 and W6; then W4 (needs W1's scheduler).
4. W7 once R2's probes, W1 and W6 merge; the nightly and ship workflows go into `main` as bootstrap PRs.
5. The harness is deleted.
6. Eval baseline run, then Wasim's model choice; its config lands before the final PR.

## Browser scenarios (`e2e/ship/agent-chat.spec.ts`, desktop and phone, test build, scripted model)

- S1: Ask a question on Today and watch the answer stream into a new chat.
- S2: Reload mid-answer; the chat picks up where it was with no lost or doubled part.
- S3: A second tab on the same chat shows the same stream.
- S4: Stop mid-answer stops that turn only; a follow-up sent while it runs acts on the right turn.
- S5: All chats lists the server's chats; an old chat opens after a reload with its full history.
- S6: A second Member can't see the first person's chat.
- S7: Memory: "remember we restock on Fridays", then a new chat asks when we restock and gets the answer.
- S8: Pause the agent; a new question is refused with a notice and a live answer stops; resume.
- S9: At the cap, a new question gets the cap notice and Usage shows the cap reached.

## Acceptance

1. A run streams to two tabs; a reload mid-answer reattaches from its `seq` with no lost or doubled part; `send`,
   `interrupt` and `stop` act on the right turn by id.
2. The socket returns 401 without a valid JWT; removing a member or ending a support grant closes their sockets and
   ends their runs' authority.
3. The contract suite passes on the mock and the real client for C4 and C5; fast-check covers reattach ordering.
4. A deferred call and a resume survive a container restart; a dropped mirror batch is repaired before a chat is
   marked waiting; eager flush is proven against a hard kill, or the gap is recorded and the person is told.
5. Every S2 probe passes in the nightly run: hosts outside the allowlist fail, no secret or token is reachable from
   Bash, one session can't read another's folder, a failing audit hook stops the call, `.claude/` isn't writable.
6. The built-in tool list is exactly the decided 20; all 20 `inhouse` definitions are registered with the agreed
   split; the four tools that didn't register headless are checked with the real server and the result recorded.
7. The scheduler runs each due task once when the alarm fires twice (tested), and the audit copy lands in R2 daily.
8. Pause stops new runs and live runs; resuming starts nothing on its own.
9. At the cap new runs get `cap_reached`; concurrent runs overshoot by at most one response each; resumed and crashed
   runs settle once; Usage matches the D1 ledger.
10. Runs fill one container before waking the next; a placement refusal routes to a running container or queues; a
    lasting shortfall raises the signal.
11. A Worker one protocol version ahead of its runner still runs chats; a deploy drains, rolls out and warms up with no
    failed run.
12. The chosen model and its effort from Settings reach `query()`; `maxTurns` is set on every run.
13. The eval suite has a recorded baseline (tool choice, recall, cost per conversation); recall doesn't drop under the
    softer memory rule; Wasim chose the product model.
14. API specs pass for every new route and the socket; if containers start in Previews, each preview has its own
    Durable Object state (backend Acceptance 11).
15. The product build contains no scripted model; the demo is unchanged.
16. QA PASS and the ship recording on S1 to S9; the real-model smoke passes on the house deployment.

## Must not

No secret, model key or tool token inside the container or in a log; no run token on `/api/*` or in a tool
subprocess's environment; no tool write path from the runner; no deprecated `Container` class; no beta scheduling
policy or snapshots; no scripted model in a deployed build; no preview pointed at the house runner; no automatic
replay of a half-done run; no second alarm owner in the BrandAgent object; no retries in tests; no paid eval run
without Wasim's OK.

## Risks

- The Agent SDK is 0.x and its behaviour runs ahead of its docs (P0). Pin it; evals on every bump.
- Container placement: refusals are normal, capacity grew over a new app's first 30 minutes, `max_instances` vs
  placement is undocumented. Route around refusals, alert on a shortfall, ask Cloudflare.
- Eager flush is alpha; if it fails, the accepted gap stands and is shown to the person.
- Containers may still not run in Previews; the test-build path above covers it.
- The chat track is the largest piece of the backend; if it runs long, split the final PR into chat first and usage
  second, each through the ship gate.

## How it lands

- Branch `fleet/agent-chat` from `main` at the runner track's start; `main` merges in after P2.
- Review rows: R1, R2, W1 to W4 and every migration at Sonnet plus Opus high (concurrency, secrets, money, schema);
  W5, W6, W7 Sonnet plus Opus medium; the nightly and ship workflow bootstrap PRs at high (secrets).
- Final PR with the full ship gate on the test build. After merge, the orchestrator releases to the house deployment
  with drain and warm-up, with Wasim's OK, and runs the real-model smoke.
