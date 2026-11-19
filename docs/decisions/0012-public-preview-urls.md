# 0012. Public preview URLs

- Status: accepted, 2026-11-19
- Was: setup plan D3
- Plan: [setup plan, Decisions](../plans/2026-11-19-setup-gaps.md#decisions)

## Context

Previews could sit behind Cloudflare Access or be public. The QA agent, the ship recording and reviewers all need to
open them without a login.

## Decision

Preview URLs on workers.dev are public. They serve only invented sample data and send `noindex`.

## Consequences

No login step in QA or the recording. Once a backend exists its previews run in a separate sandbox account with the
scripted model (backend plan), so this holds only while previews carry no real data.
