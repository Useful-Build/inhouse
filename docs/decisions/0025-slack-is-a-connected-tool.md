# 0025. Slack is a connected tool the agent reads, and a channel from Act

- Status: accepted, 2026-11-22
- Supersedes: [0006](0006-slack-is-a-connected-channel.md)
- Plan: [P5, connectors](../plans/2026-11-19-p5-connectors.md) (Scope, Context)

## Context

0006 connected Slack in the demo only as a channel from Act, "not a tool the agent reads". P5 builds the real
connection through the connector hub, and the Slack record ([S4](p0-s4-connector-hub.md)) proved reads behind the hub.

## Decision

Slack is a connected tool. The Inhouse team connects it through the hub. For the agent it is read-only (search and
read tools) and it is the first read tool beside Shopify. From Act, `notification_send` can also post a notice to
the Slack channels the brand's admin listed. At Watch a notice reaches the in-app bell only, and the server enforces
that by stage. Admins see the Tools page read-only.

## Consequences

Writes still go only through our server: the runner never gets Slack write access, and a Slack DM is out. Slack's
write tools appear only with a per-run grant the server sets. `channelFrom` in `app/src/state/derive.ts` still
resolves the channel by stage; Tools, a tool page and the composer now treat Slack as a tool the agent reads as well.
0006 stays as history.
