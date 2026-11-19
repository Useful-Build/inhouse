# 0023. Repo security settings

- Status: accepted, 2026-11-19. Built in the hardening project (`fleet/hardening`)
- Was: production plan PD9
- Plan: [production plan, Decisions](../plans/2026-11-19-production.md#decisions)

## Context

Dependabot security updates, CodeQL and private vulnerability reporting were off. There was no `SECURITY.md`, the
workflow token could approve PRs, and any action could run.

## Decision

Dependabot alerts and grouped weekly updates (`npm` in `app/`, `github-actions`). `pr-gates` skips the trailer
check only for PRs opened by `dependabot[bot]`, a login GitHub sets. CodeQL default setup, private vulnerability
reporting, `SECURITY.md`, a workflow token that can't approve PRs, only GitHub-owned and listed actions, SHA pinning
required.

## Consequences

Security reports go through GitHub privately (see [CONTRIBUTING](../../CONTRIBUTING.md)). A new action has to be
listed before a workflow can use it.
