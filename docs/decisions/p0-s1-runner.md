# P0 S1: the runner on `ctx.container`, and sizing

Date: 2026-11-19. Status: final. Backend plan open tests 1 and 4, plus a sizing test for a 50-person brand.
Plan: `docs/plans/2026-11-19-backend.md`.

## What was tested

A throwaway runner on the house account: a Durable Object owning one container through `ctx.container` on the
`default` scheduling policy (not the beta `durable_object` policy), a small Node server wrapping the Claude Agent SDK
(0.3.328, CLI 2.1.328), internet off, every outbound call intercepted. The model key never entered the container: the
Worker's egress entrypoint added it. Transcripts mirrored to a `sessionStore` on R2. Model: Haiku 5.5 for every call.

1. One `query()` per run, resumed from the store for the next run, across container restarts.
2. A deferred `question_ask` held, the container destroyed, the answer delivered in a new container.
3. The one-call limit on deferral.
4. A dropped mirror batch, with and without a repair step.
5. Stopping a run mid-way: SIGTERM against a hard destroy.
6. The concurrent-run ceiling on one standard-1 container.
7. Sizing: 60 and 75 runs sent at once to one brand on standard-4 and a custom 2 vCPU type.

## Results

| Test | Result |
|---|---|
| Runner on `ctx.container`, one `query()` per run | Pass |
| `sessionStore` on R2 | Pass, after both destroy and SIGTERM restarts |
| Deferred call across a restart | Pass, if the resume prompt is `""` |
| One-call limit | Docs and behaviour differ: defer was honoured with two parallel calls in one turn |
| Dropped mirror batch | Pass with the repair step; without it the resume fails ("No conversation found") |
| Stop mid-run | SIGTERM keeps the transcript; a hard destroy loses that turn's transcript |
| Ceiling on standard-1 | CPU-bound: 16 at once, 0 errors, latency grows linearly from 2 |

**Latency** (one-tool question, standard-1): warm 2.9 to 3.4 s, first token 1.2 to 1.3 s; warm follow-up resumed from
the store 3.5 s; cold after destroy 4.1 to 5.8 s, boot 0.7 to 1.3 s.

**Ceiling on standard-1** (half a vCPU): about 1.5 CPU-seconds and 190 MB per run. p50 4.0 s at 1 run, 7.0 s at 2,
52 s at 16, with 0 errors at every level. Memory is never the limit; CPU is.

**Sizing** (two-lookup question, warm unless marked, 0 errors in every row):

| Setup | At once | p50 | p95 |
|---|---|---|---|
| standard-4 x 4, cold | 60 | 6.1 s | 9.0 s |
| standard-4 x 3 | 60 | 5.5 s | 7.4 s |
| standard-4 x 3 | 75 | 6.7 s | 8.9 s |
| standard-4 x 2 | 60 | 7.6 s | 10.2 s |
| custom 2 vCPU x 8 | 60 | 5.9 s | 11.0 s |

- CPU per run 0.7 to 0.96 CPU-s on standard-4, about 170 MB per live run, at most 6.4 GB of 12 GiB used.
- At equal vCPU, standard-4 beats 2 vCPU containers on the tail and needs half as many containers.
- Model API time held at about 2 s median at 75 at once: no rate limit hit.
- Run to run variance is real: an earlier round on 3 containers gave p50 11.3 s. Budget for the slower figure.
- Cost per run at public prices: model about $0.0002 on Haiku with tiny tools; container CPU about $0.00002. An awake
  standard-4 costs about $0.113 an hour; containers sleep after the inactivity timeout and then cost nothing.

## Problems found (each a plan input)

1. **Every `query()` stalled 60 to 140 s with internet off.** The SDK calls `process.report.getReport()`, which
   reverse-resolves every open socket and waits on DNS timeouts. Fix: `process.report.excludeNetwork = true` before
   the SDK loads (2 ms instead of 40 s per socket). S2 confirmed it independently.
2. **A deploy runs the new Worker before the new image.** The image reached containers about 6 minutes after the
   Worker went live; in between every run failed. The rollout also restarted a container mid-run, with about a minute
   of errors.
3. **The DO learned the session id only from the result line,** so a run stopped mid-way couldn't resume. Fixed by
   the DO naming the session up front (`sessionId` on the first run, `resume` after).
4. **The inactivity timeout was lost** when a DO object was recreated and found its container already running. The
   platform then stopped the container under live runs (bursts of 11 and 25 runs SIGTERMed). Fix: set it on every run.
5. **Placement refusals.** `There is no container instance that can be provided to this Durable Object, try again
   later` (answered 1101) came back 400+ times. With `max_instances: 6` only 3 standard-4 containers would start;
   at 12, all 4 started. A new container app's capacity near our Durable Objects grew over its first 30 minutes. Not
   documented; ask Cloudflare.
6. Custom instance types need at least 3 GiB per vCPU (learned from a rejected rollout, not in the docs).

## Verdict

The runner design holds on `ctx.container` and the `default` policy, with the rules below. Size on standard-4.
The runner pool (standard-4, max(2, ceil(peak concurrent runs / 25)), fill-first) was decided by Wasim on 2026-11-19.

## Alternatives considered

Cloudflare's largest container is standard-4 (4 vCPU, 12 GiB), which is also the per-instance cap. Bigger single
containers exist elsewhere: AWS Fargate up to 32 vCPU and 244 GB, Google Cloud Run up to 8 vCPU and 32 GiB, and plain
VMs at any size (docs read 2026-11-19). We stay on Cloudflare with a pool. Cost follows total vCPU either way, and one
big container is a single point of failure that every deploy or crash would cut at once.

## What it changes in the plan

- Runner: `process.report.excludeNetwork = true` at start is a hard requirement.
- The BrandAgent object names each chat's session; a deferred call resumes with prompt `""`.
- Keep the runner's own one-call check for deferred tools.
- Checkpoint: the runner keeps every batch until the store confirms it, re-sends a dropped batch under its own part id,
  then checks the run's uuids with `load()`. Only then is a chat marked waiting.
- Hard kill: with the default batched flush, the live turn's transcript is lost. Stop with SIGTERM first; mirror during
  the turn (test `sessionStoreFlush: 'eager'`, alpha, in P3). Until proven, a run cut off mid-way restarts from its
  last completed run and the person is told.
- Re-apply the inactivity timeout on every run.
- Releases: the versioned Worker-runner protocol is mandatory. Deploy with `--containers-rollout=immediate`, drain
  first, warm up after.
- Sizing: standard-4, containers per brand = max(2, ceil(peak concurrent runs / 25)), routed fill-first. A pool of
  runner DOs per brand (`runner-0..N`, each owning one container), not one container per brand. `max_instances` at
  least 3 times the need. Placement refusals are normal: route to a running container, alert on a shortfall.
- Open for P3: `interrupt()` before abort on SIGTERM (abort alone didn't end the turn loop); read memory without the
  cgroup files (not readable here); cold start over long idles and many brands.

## Docs read (2026-11-19)

- https://developers.cloudflare.com/containers/configuration/outbound-traffic/
- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-container-api/
- https://developers.cloudflare.com/containers/platform-details/limits/
- https://developers.cloudflare.com/containers/platform-details/scaling-and-routing/
- https://developers.cloudflare.com/containers/pricing/
- https://developers.cloudflare.com/workers/wrangler/configuration/ (containers, scheduling policies, custom types, `max_instances`)
- https://code.claude.com/docs/en/agent-sdk/session-storage
- https://code.claude.com/docs/en/hooks (deferring a tool call)
- https://code.claude.com/docs/en/agent-sdk/typescript (`sessionId`, `sessionStoreFlush`, `deferred_tool_use`)
- https://code.claude.com/docs/en/agent-sdk/hosting, /agent-sdk/secure-deployment, /agent-sdk/user-input
- https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html (Fargate task sizes)
- https://cloud.google.com/run/docs/configuring/services/cpu and /memory-limits (Cloud Run limits)
