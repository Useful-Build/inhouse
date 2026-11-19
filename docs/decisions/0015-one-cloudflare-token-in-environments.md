# 0015. One Cloudflare token, held in GitHub environments

- Status: accepted, 2026-11-19
- Was: setup plan D6, production plan PD5
- Plan: [setup plan, Decisions](../plans/2026-11-19-setup-gaps.md#decisions), [production plan, Decisions](../plans/2026-11-19-production.md#decisions)

## Context

Previews and production deploys both need a Cloudflare token. Where it lives decides who can reach it.

## Decision

One token, made from Cloudflare's documented "Edit Cloudflare Workers" template and scoped to the one account and
zone. It sits in GitHub environments `preview` and `production`, whose deployment branches are `main` only, with
the account id as an environment variable. Only trusted workflow code on `main` ever holds it.

## Consequences

- A PR can't change the code that uses the token until it merges, and every review covers that code.
- One token for two jobs keeps setup simple. Splitting it is a small change if the blast radius ever matters more.
