# P3: agent chat (`fleet/agent-chat`)

Status: draft, 2026-11-19. Phase plan under the backend plan (`docs/plans/2026-11-19-backend.md`). Common rules are in
its "Phase schedule (waves)" section. P0 records: [S1](../decisions/p0-s1-runner.md),
[S2](../decisions/p0-s2-container-guards.md), [S3](../decisions/p0-s3-previews.md),
[S5](../decisions/p0-s5-memory-tool-choice.md).

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
  guard probe tests from S2; the re-check of the four built-in tools that didn't register headless.
- **Chat track (C):** the BrandAgent Durable Object; the runner pool (standard-4, `max(2, ceil(peak / 25))`,
  fill-first, placement-refusal routing, a brief queue, the inactivity timeout set on every run, the shortfall
  signal); the egress entrypoint with the per-run token table; the AI Gateway with payload logging off; usage and the
  cap; the scripted model; **C4** chat history; **C5** streaming and reattach; the `inhouse` MCP server with the memory
  and history tools; the daily audit copy to R2; drain and warm-up on deploy; the eval harness seeded from S5; the
  nightly guard tests.

Out: routines, Today and connectors (P4, P5); approvals, `question_ask` and skills of our own (P6); the Bedrock switch
(P8). The other `inhouse` tools are registered later in the phase that first needs them.

## Inputs and gates

- Runner track: none beyond this plan (it uses the house account under P0's credential rules); it starts early (see
  the schedule).
- Chat track: P2 merged into `main` (Access, members, D1, previews, the real client).
- **From Wasim before the chat track:** our Anthropic key in the house deployment's AI Gateway (he adds it himself), a
  spend limit for P3's model calls, and OK for the paid eval runs (the `evals` skill).
- **Open with Cloudflare before the runner pool merges:** how `max_instances` relates to placement near a brand's
  Durable Objects. Without an answer, the pool ships with `max_instances` at 3 times the need and the shortfall alert.
- **Gate at the end of P3 (Wasim):** the product model, chosen on the eval suite's results (decision log, "P0
  models").

## Design notes

- **Layout.** `app/runner/` (its own `package.json`, `Dockerfile`, `src/`, `test/`, and a small `harness/` Worker for
  running the runner under `wrangler dev` before P2's server exists). Server pieces under `app/server/do/`,
  `app/server/egress/`, `app/server/model/`, `app/server/usage/`, `app/server/mcp/`.
- **Protocol.** `app/shared/protocol/` holds the zod schemas for Worker-runner messages and the version constant; the
  Worker accepts the current and previous version. Run events for the browser carry their own protocol version (C5).
- **The runner track merges into this branch early.** It never touches `app/src/`, `app/server/` or shared configs
  other than `app/shared/protocol/`, so it runs while P1 and P2 are open. The harness is replaced by the real runner
  Durable Objects once P2 has merged into the branch.
- **Test path for containers.** P0 S3 found containers don't start in Previews; P2 retests. Until they do, container
  E2E runs under `wrangler dev` in CI (Docker on the runner) and on the house deployment; never by pointing a preview
  at the house runner (backend plan, Tests 5). The ship recording runs on the house deployment behind Access with the
  QA service token if previews can't host containers.
- **Scripted model.** A fake Anthropic endpoint (`app/test/scripted-model/`), keyed by scenario and turn; a miss fails
  the test. Test and preview only; P1's product build check gets its canary.
- **Memory prompt rule:** the softer rule (decision log, 2026-11-19): search memory when the question could depend on
  saved context. The eval checks recall doesn't drop.

## Workers

| Id | Role, model, effort | Job | Owns | Waits for |
|---|---|---|---|---|
| R1 | opus-worker (Opus 5.5, medium), sensitive: concurrency | The runner's run lifecycle: the HTTP or socket server, one `query()` per run with `settingSources: []` and auto memory off, `process.report.excludeNetwork = true` before the SDK loads, stable working folders, `sessionId` and `resume`, the `""` resume prompt, the session store adapter with the checkpoint and repair, `mirror_error`, eager flush against a hard kill, SIGTERM with `interrupt()` then flush, the protocol handshake. | `app/runner/src/{server,run,store,protocol}/**`, `app/shared/protocol/**`, `app/runner/package.json` | none |
| R2 | opus-worker (Opus 5.5, medium), sensitive: guards | The guards: root runner spawning one OS user per session, the 0755 work root and `stubs` session layout, SDK sandbox (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`), the tools lock (the decided 20), the skills lock (`dataviz` plus ours, overrides and plugins off), skills through `plugins` from a read-only path, the blocking audit hook, the WebFetch list; the S2 probe set as tests; the four-tool re-check with a `canUseTool` callback; the Dockerfile. | `app/runner/src/guards/**`, `app/runner/Dockerfile`, `app/runner/test/**`, `app/runner/harness/**` | none |
| W1 | opus-worker (Opus 5.5, medium), sensitive: concurrency | BrandAgent object: runs and turns, the event log with `seq` in SQLite, WebSocket fan-out with hibernation and Access-checked upgrade, `attach(runId, fromSeq)`, `send`, `interrupt` and `stop` by turn id, the per-brand concurrent-run limit, Pause for new and live runs, session naming, the run token table, socket close on member removal or grant end, finished messages to D1. | `app/server/do/brand-agent/**`, `app/server/api/{runs,chats}.ts`, `app/shared/contract/{runs,chats}.ts` | P2 merged |
| W2 | opus-worker (Opus 5.5, medium), sensitive: concurrency | Runner pool: runner Durable Objects with `ctx.container`, fill-first routing, placement refusal as a normal outcome, a short queue when all are full, the inactivity timeout on every run, protocol version check, the shortfall signal, the drain and warm-up routes for deploys. | `app/server/do/runner/**`, `app/server/ops/{drain,warmup}.ts` | P2 merged; R1's protocol |
| W3 | opus-worker (Opus 5.5, medium), sensitive: secrets | Egress entrypoint: pinned upstreams, request and redirect validation, credentials added at the edge, run tokens checked against W1's table (never carried in intercept props); the AI Gateway route with the brand key and payload logging off; the scripted model endpoint. | `app/server/egress/**`, `app/server/model/**`, `app/test/scripted-model/**` | P2 merged |
| W4 | opus-worker (Opus 5.5, medium), sensitive: money | Usage and the cap: the D1 reservation with one conditional update, `maxBudgetUsd` from it, idempotent settle deltas, settle from the gateway log for a run with no result, `cap_reached`, the Usage page's real numbers, the Settings alert threshold; the daily audit copy to R2. | `app/server/usage/**`, `app/server/audit-copy.ts`, `app/shared/contract/usage.ts` | W1's run registry |
| W5 | sonnet-worker (Sonnet 5.5, medium) | C4 and C5 on the mock, the UI and the real client: `listChats()`, `getChat(id)`, drafts and view choices only in the browser; events with `seq`, `turnId`, `messageId` and protocol version; `activeRuns()`, `attach`; `send` returns a `turnId`; async `getTrace`; the WebSocket client with reattach and a reload prompt for an unreadable version. | `src/agent/mock.ts`, `src/agent/http/stream/**`, `src/screens/chat/**`, `src/screens/Chats.tsx`, `src/overlays/TraceWindow.tsx`, the chat slice of `src/state/store.ts` | P2 merged; W1's contract file |
| W6 | sonnet-worker (Sonnet 5.5, medium) | The `inhouse` MCP server on the Worker over D1, with `memory_search`, `memory_save` (refuses customer personal data; brand facts wait for an admin, person facts count at once) and `history_search` on FTS5. Migration proposal for the memory tables. | `app/server/mcp/**` | P2 merged |
| W7 | sonnet-worker (Sonnet 5.5, medium) | The eval harness from S5 (43 cases, the code-only grader with its three fixes, recall, tool choice, cost per conversation), results kept per the `evals` skill; the nightly workflow on the house deployment for the guard tests and evals. | `app/evals/**`, `.github/workflows/nightly.yml` (bootstrap PR into `main`) | R2's probes, W6 |

## Orchestrator only

- `app/server/routes.ts`, `app/wrangler.product.jsonc` (Durable Object classes, containers, R2, AI Gateway binding;
  classes only ever added), migrations `0100`-`0199`, `app/package.json` and lockfiles, `app/shared/contract/index.ts`,
  `vite.config.ts`, `playwright.config.ts`, `.github/workflows/ci.yml` (container tests under `wrangler dev`).
- The release step: drain, deploy with `--containers-rollout=immediate`, warm-up, on the house deployment.
- `AGENTS.md`, `verify` skill, feature map, `e2e/ship/agent-chat.spec.ts`, the eval results write-up.

## Order and parallelism

1. Runner track (R1, R2) from the start of its wave, on `fleet/agent-chat` cut from `main`, against the harness.
2. When P2 merges: `main` into the branch; W1, W2, W3, W5 in parallel (W2 takes R1's protocol).
3. W4 once W1's run registry merges; W6 in parallel with W4.
4. W7 once R2's probes and W6 merge; its nightly workflow goes into `main` as a bootstrap PR.
5. The harness is deleted once the real runner objects carry the runner tests.
6. Eval baseline run, then Wasim's model choice; the chosen model's config lands before the final PR.
7. At most 2 workers in the runner track; at most 5 at once in the chat track.

## Browser scenarios (`e2e/ship/agent-chat.spec.ts`, desktop and phone, scripted model)

- S1: Ask a question on Today and watch the answer stream into a new chat.
- S2: Reload mid-answer; the chat picks up where it was with no lost or doubled part.
- S3: A second tab on the same chat shows the same stream.
- S4: Stop mid-answer stops that turn only; a follow-up sent while it runs acts on the right turn.
- S5: All chats lists the server's chats; an old chat opens after a reload with its full history.
- S6: A second Member can't see the first person's chat.
- S7: Memory: "remember we restock on Fridays", then a new chat asks when we restock and gets the answer.
- S8: At the cap, a new question gets the cap notice and Usage shows the cap reached.

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
6. The tool list is exactly the decided 20 plus our MCP tools; the four tools that didn't register headless are
   checked with the real server and the result recorded.
7. At the cap new runs get `cap_reached`; concurrent runs overshoot by at most one response each; resumed and crashed
   runs settle once; Usage matches the D1 ledger.
8. Runs fill one container before waking the next; a placement refusal routes to a running container or queues; a
   lasting shortfall raises the signal.
9. A Worker one protocol version ahead of its runner still runs chats; a deploy drains, rolls out and warms up with no
   failed run.
10. The daily audit copy lands in R2.
11. The eval suite has a recorded baseline (tool choice, recall, cost per conversation); recall doesn't drop under the
    softer memory rule; Wasim chose the product model.
12. The product build contains no scripted model; the demo is unchanged.
13. QA PASS and the ship recording on S1 to S8.

## Must not

No secret, model key or tool token inside the container or in a log; no run token on `/api/*` or in a tool
subprocess's environment; no tool write path from the runner; no deprecated `Container` class; no beta scheduling
policy or snapshots; no preview pointed at the house runner; no automatic replay of a half-done run; no retries in
tests; no paid eval run without Wasim's OK.

## Risks

- The Agent SDK is 0.x and its behaviour runs ahead of its docs (P0). Pin it; evals on every bump.
- Container placement: refusals are normal, capacity grew over a new app's first 30 minutes, `max_instances` vs
  placement is undocumented. Route around refusals, alert on a shortfall, ask Cloudflare.
- Eager flush is alpha; if it fails, the accepted gap stands and is shown to the person.
- Containers may still not run in Previews; then per-PR container proof is `wrangler dev` in CI and the house
  deployment, and the QA gate runs there.
- The chat track is the largest piece of the backend; if it runs long, split the final PR into chat first and usage
  second, each through the ship gate.

## How it lands

- Branch `fleet/agent-chat` from `main` at the runner track's start; `main` merges in after P2.
- Review rows: every R and W1 to W4 piece at Sonnet plus Opus high (concurrency, secrets, money); W5, W6, W7 Sonnet
  plus Opus medium; the nightly workflow at high (secrets).
- Final PR with the full ship gate; the scenarios run on the house deployment if previews can't host containers.
  After merge, the orchestrator releases to the house deployment with drain and warm-up and runs the ship specs as a
  smoke.
