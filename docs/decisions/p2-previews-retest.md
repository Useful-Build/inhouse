# S3 retest: containers in Previews, and Access with a service token (2026-11-19)

Wave 0 spike. Retests P0's S3 ([`p0-s3-previews.md`](p0-s3-previews.md)). Code: local branch
`spike/backend-impl-s3-retest`, `spikes/s3-retest/` (never pushed). Raw outputs kept privately. No model calls.
Hostnames, team domain, account and tag values are left out on purpose.

## Verdicts

1. **Containers in Previews: they work.** A tiny container answered in about 10 s in production and about 10 s after
   creating a Preview, with wrangler 4.165.0, `ctx.container` and `monitor()`. P0's failure did not come from Previews:
   the same images fail the same way in production. `monitor()` shows the cause as the container process exiting at
   once (exit code 1 or 127), not a Preview pipeline fault. Why those images exit is **not fully explained** (see below).
2. **Access with a service token in front of a Worker: it works**, including on Preview URLs. The Worker verifies the
   JWT itself and reads the token identity from `common_name`.

## Question 1: containers in Previews

**Setup.** `ctx.container` in a SQLite-backed Durable Object, `start()` then `monitor()` logging to storage (served at
`/container/log`, because `wrangler tail` can't target a Preview). The Worker probes the container once per request and
a shell loop polls every 8 s. Images are **public Docker Hub references** (`containers[].image` is a registry reference,
default scheduling policy), so no Docker build was needed. Production first, then a Preview, with `containers` and
`previews.containers` both declared from the first deploy.

| Run (image, start options) | Where | Result |
|---|---|---|
| busybox:1.36, `entrypoint busybox httpd -p 8080`, internet on | production | first request: `no container instance that can be provided ... try again later` (0.5 s); **second request 9 s later answered** (HTTP 404 from httpd, so the container is up). About 14 s after the deploy. |
| same | Preview `pr1` (created after the production deploy) | same pattern, **answered on the second poll, 10 s after the first** (about 16 s after creating the Preview) |
| same, internet off (`enableInternet:false`, P0's setting) | Preview `noinet` | answered on the first poll |
| same, port 80 | Preview `p80` | answered on the first poll |
| nginx:1.27-alpine, default start | production, 20 min | **0 of 147 probes answered.** `monitor`: `Container exited with unexpected exit code: 1` within about 40 ms of every `start()` |
| same | Preview `pr1`, 20 min | **0 of 146.** Identical |
| nginx:1.27-alpine, internet on / explicit `nginx -g 'daemon off;'` entrypoint | Previews `inet`, `ep` | never answered, exit code 1 |
| httpd:2.4-alpine, default start | Preview | never answered (not listening, then not running) |
| alpine:3.20, `busybox httpd -p 8080 -h /etc` (P0's shape), plain and absolute path | Previews | never answered, **exit code 127** |

What this shows:
- The platform side is fine in both places: Preview container apps are created, scheduled, and answer in seconds.
  The first `start()` on a fresh app returns `no container instance ... try again later` once; a retry on the next
  poll worked every time. A probe must retry.
- "The container is not running, consider calling start()" (P0's message) is what a probe sees **after** the process
  has already exited. P0 never captured the exit because it had no `monitor()`. It was an exiting process, not a hung
  pipeline.
- Every Alpine-based image I tried exits at once (nginx and httpd with 1, plain alpine with 127), in production and in
  Previews alike. The glibc busybox image runs. P0's image was Alpine. **Cause not proven.** Candidates: a musl or
  architecture mismatch in how Docker Hub images are resolved (the docs say images must be `linux/amd64`), or the
  firecracker runtime's handling of these images. Telling these apart needs a Dockerfile-built image (Docker), so I did
  not.

**Resource facts found on the way**
- Preview container apps are named `<worker>_<preview>_<Class>` (confirmed). Production apps are `<worker>-<class>`.
- Deleting a Worker leaves its container apps. wrangler 4.165.0 now prints a warning for the **production** apps it
  finds, but not for the Preview apps: all 9 Preview apps were still there after their Worker was deleted (I deleted them
  next, through the API).
- `wrangler preview` on a Worker that does not exist yet creates it (non-interactive fallback "yes"), no production
  deploy needed.
- `npx -y wrangler@4` resolved to a cached 4.152.0 while npm's latest is 4.165.0. Pin the version in CI.

## Question 2: Access with a service token in front of a Worker

**Setup.** Gate Worker `w0-s3r-gate` (no library: RS256 check against `<team>/cdn-cgi/access/certs`, then `iss`, `aud`,
`exp`, `nbf`). Two Access applications, each with one Service Auth policy (`decision: non_identity`) naming the service
token: app 1 covers the production hostname, app 2 covers `*-w0-s3r-gate.<subdomain>.workers.dev` (every Preview and
Deployment URL). Service token made through the API with a 6 h life.

| Case | Result |
|---|---|
| No headers, production host | 403 from Access (HTML). Worker did not run. |
| Valid `CF-Access-Client-Id` / `-Secret` | 200 from the Worker |
| Right id, wrong secret | 403 from Access |
| Worker reads the JWT | claims: `aud, common_name, exp, iat, iss, policy_id, sub, type`. `type` is `app`, **`common_name` is the token's client id**, `sub` is an empty string, no `email`. |
| Access bypassed (Preview host not covered by app 1): no JWT, token headers only, garbage JWT, payload altered | Worker refuses all four: `missing jwt`, `missing jwt`, parse error, `bad signature` |
| Wrong `aud` (Preview deployed with a wrong `POLICY_AUD`), real JWT | Worker refuses: `aud mismatch` |
| Preview URL with app 2 in front | no headers 403 from Access; valid token reaches the Worker |
| Same Preview, Worker checking app 1's `aud` | Worker refuses `aud mismatch`: **each Access application has its own `aud`** |
| Same Preview with app 2's `aud` in `previews.vars` | 200, identity read; the per-deploy Deployment URL also 200 |

Notes: Access answers an unauthenticated request with a plain 403 (no IdP in the app), good for machine callers. The
wildcard destination matched Preview and Deployment URLs. App 1 kept working after app 2 existed.

## What it changes in the P2 plan
1. **Risk "Access with a service token was unverified" is closed.** The `monitor` and `smoke` principals can be built
   on service tokens. Identity to log and authorize on is `common_name` (the client id), not `sub`.
2. **The audience check is per application, and Previews need their own.** With one app for production and one wildcard
   app for Previews, the Worker needs `POLICY_AUD` (and `TEAM_DOMAIN`) in `previews.vars`, because Preview vars are not
   inherited. A single app that lists both hostnames would give one `aud`, which is simpler: decide at PR0.
3. **Q1 can keep previews with containers**, with these conditions: log `monitor()` for every container and keep it in a
   place a test can read (tail doesn't work on Previews); the probe retries (first `start()` on a new app fails once);
   the teardown job deletes the Preview's container apps by the `<worker>_<preview>_` prefix, because Worker or Preview
   deletion leaves them (list, check the ids, then delete).
4. **Image choice needs one more proof before P3.** Alpine-based images exited at once here and in P0. P2's real image
   must be run once in a Preview with `monitor()` before any E2E depends on it. Prefer a glibc base until an Alpine
   image is shown to run.
5. Acceptance item 13 stands as written ("a service token held by no job that runs PR code" is untested here; this
   spike only proves the mechanism).
6. Pin wrangler to an exact version in CI (cached `@4` was 13 patch versions behind).

## Cleanup (all created resources deleted; checked 2026-11-19 through the API)
Created and deleted: Workers `w0-s3r-box`, `w0-s3r-box2`, `w0-s3r-box3`, `w0-s3r-box4`, `w0-s3r-gate` (their 11 Previews
went with them: Preview host answers 404); 11 container apps `w0-s3r-*` (2 production, 9 Preview); Access applications
`w0-s3r-gate-app` and `w0-s3r-gate-preview-app`; service token `w0-s3r-token`. The service token's client secret was
shown once by the API, used only in command arguments in this session, never written to a file, and the token was
deleted about 22 minutes after it was created.
Proof: `GET containers/applications` returns `[]`; `GET access/apps?search=w0-s3r` returns 0; `GET access/service_tokens`
lists only another project's token; `GET workers/scripts` lists no `w0-s3r-*` Worker. Org-level Access settings were
read once and never changed. Container images pulled from Docker Hub only; nothing was pushed to the Cloudflare registry.

## Docs read (2026-11-19)
- Workers Previews: <https://developers.cloudflare.com/workers/previews/>, `/get-started/`, `/resources/`
- Containers: <https://developers.cloudflare.com/containers/get-started/>, `/configuration/wrangler/`,
  `/platform-details/image-management/`, `/platform-details/architecture/` (amd64, lifecycle, `monitor()`)
- Wrangler config, containers section: <https://developers.cloudflare.com/workers/wrangler/configuration/>
- Service tokens: <https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>
- Validating the Access JWT: <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/>
- Access applications API: <https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/>
