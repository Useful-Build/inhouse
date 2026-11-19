# P0 S3: Worker Previews

Date: 2026-11-19. Status: final. Backend plan Tests 5 (per-PR previews). Plan: `docs/plans/2026-11-19-backend.md`.

## What was tested

A probe Worker, never deployed to production, put into Workers Previews with wrangler 4.152.0: a Durable Object alarm,
a container, a per-PR D1 binding and Access with a service token.

## Results

| Check | Result |
|---|---|
| Durable Object alarms | **Works.** A 5 s alarm fired 1 ms after its time. Each Preview gets its own DO namespaces |
| Per-PR D1 | **Works.** `previews.d1_databases` bound a per-PR database. The binding is static config, so CI must generate it per PR |
| Container | **Didn't start.** Try 1: a Preview first made without a container can't gain one (`DURABLE_OBJECT_NOT_CONTAINER_ENABLED`). Try 2: declared from the first deploy, created without error, but never answered in 20+ minutes ("The container is not running") while the Worker and D1 answered at once |
| Access with a service token | **Unverified.** No wrangler command; dashboard only |

Other facts: creating a Preview needed no prior production deploy and took about 2 s. Previews answer with
`x-robots-tag: noindex`. `wrangler tail` can't target a Preview. Limits: 500 Previews per Worker on Paid, 100
deployments per Preview. Cron Triggers, queue consumers and routes don't apply to Previews. Deleted Previews can leave
container apps behind, so cleanup must check for them.

## Verdict

Alarms and per-PR D1 are proven in Previews. Containers in Previews are not: the container cause is unknown (the
partial Preview pipeline, or the probe). Don't build container E2E on Previews.

## What it changes in the plan

- BD10 (alarms over Workflows) holds.
- Tests 5: per-PR D1 needs a generated config (or a reviewed `previews` block) in CI, so the `previews: {}`-only gate
  changes. Cleanup also deletes container apps.
- Container E2E runs under `wrangler dev` and on the house deployment. Retest containers in Previews at P2 (with
  `monitor()` logging and a newer wrangler).
- Access with a service token is checked at P2 when previews are set up.

## Docs read (2026-11-19)

- https://developers.cloudflare.com/workers/previews/
- https://developers.cloudflare.com/workers/previews/get-started/
- https://developers.cloudflare.com/workers/previews/configuration/
- https://developers.cloudflare.com/workers/previews/resources/
- https://developers.cloudflare.com/workers/previews/examples/
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- https://developers.cloudflare.com/workers/configuration/previews/
- https://developers.cloudflare.com/containers/get-started/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://github.com/cloudflare/workers-sdk/issues/16127 (related open bug, different error)
