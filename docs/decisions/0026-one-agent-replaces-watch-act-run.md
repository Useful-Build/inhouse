# 0026. One agent with a proactive switch replaces Watch, Act and Run

- Status: proposed, 2026-11-24 (accepted when Wasim approves the master plan)
- Plan: [Master plan 2026-11-24](../plans/2026-11-24-master-plan.md)
- Supersedes the tier sequence in the [backend plan](../plans/2026-11-19-backend.md) and the
  [2026-11-22 master plan](../history/2026-11-22-master-plan.md)

## Context

The backend plan grew the agent in three stages a brand moves through: Watch (read-only), Act (writes with approval)
and Run (agreed jobs alone). Watch was built. On 2026-11-24 Wasim judged that a read-only tier won't hold value a year
out, since the large agents now read and act in one conversation. A council (GPT-6.2 Sol, Claude Fable 5.2, Gemini 4
Neon; Opus 5.5 coordinating) reviewed the code and current sources over two rounds and agreed.

## Decision

- One agent in one app reads, answers and acts. The stage integer and its gates (`app/server/stage/`) are retired.
- Two controls only: a brand **Proactive** switch (default off) with its own monthly model-spend budget, and
  permission prompts in the flow (**Allow once**, **Always allow**) decided on the server.
- Hard guardrails "Always allow" never unlocks: money, customer-facing or public effects, deletions and irreversible
  changes, permission and connection changes, more than 5 records in one action or past a grant's count, unreviewed
  MCP write tools, logged-in browser steps.
- Member grants cover the member's own chats; only admins grant for the brand; proactive runs use brand grants only;
  Inhouse sets a per-brand ceiling.
- Keep the Claude Agent SDK runner, BrandAgent and the hub. Proactive work extends the routines engine.
- Build first; connection and proving it live are paused.

## Consequences

- P6 (Act) and P7 (Run) are no longer phases a brand moves through. Their designs (operation table, outbox, hold, Undo,
  `needs_check`, atomic limits) are reused in milestones M2 and M3.
- "Read only" leaves the prompt and the screens; the Watch release, soak and Watch-only evals are replaced by the new
  plan's Stage 3.
- The proactive budget needs a second pool in the usage ledger.
- 0025's "Slack writes only from Act" becomes "Slack writes through the outbox under a grant".
