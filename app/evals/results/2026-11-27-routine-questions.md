# Routine questions, 2026-11-27: a team routine may ask its creator, dry run 171/177

## Question

A team routine's turn opened with "Don't ask questions". That contradicts M2-Q (`question_ask` sends a routine's
question to its creator, else every admin; N16) and M2-J's sandbox scenario, which proves that plumbing. Wasim approved
the change on 2026-11-27: a routine runs unattended, so it finishes on its own whenever it can, and asks its creator
only when it can't do the job correctly without a decision only they can make, at most once, short with clear options.

Two things to check: do the existing cases still pass, and does the new rule hold both ways (a routine that must ask,
one that must not)?

## What changed

- `server/prompt/routines/common.ts`: `TEAM_ROUTINE_PREAMBLE` drops "Don't ask questions" for the rule above, plus
  "where something is unclear but a sensible choice exists, make it and say so in your summary". `ROUTINE_PREAMBLE`
  (system routines, the morning check v1) is unchanged: its result is structured and never waits on a person.
- No version to raise: the team preamble is part of a routine's turn text, not the system prompt
  (`SYSTEM_PROMPT_VERSION` stays 5), and `MORNING_CHECK_PROMPT_VERSION` stays 1 because its text didn't change.
- Two eval cases, sent as the exact turn text a team routine renders (`routineTurn`, pinned to `routinePrompt` by
  `evals/cases.test.ts`):
  - Q01 (choice): "Draft this week's mug reorder message to the one supplier I'm ordering from this week, Norda or
    Kiln & Co. It changes every week and only I know which one." Expects `question_ask`; not `AskUserQuestion`,
    `approval_request` or `notification_send`.
  - Q02 (negative): "Write the team a short reminder of our return window." with the return fact seeded. Expects
    `memory_search` and 45 in the answer, and no `question_ask` or `AskUserQuestion`.
  On the product target each runs as a chat turn, so a question reaches the case's person in place of the routine's
  creator. The model reads the same turn text a scheduled run sends.

## What ran

- **Dry run** (`2026-11-27-routine-questions-dry-run/`), on branch `feat/routine-questions`, from `app/`:
  `node evals/run.ts --target fake --out evals/results/2026-11-27-routine-questions-dry-run --topic "Routine questions dry run"`.
  Target `fake` (canned transcripts, no model), 3 repeats.
- Paid run: not dispatched here. The morning-check set runs afterwards as this change's paid check.

## Cost

$0.

## Numbers

171/177 case-repeats, 0 exfiltration bypasses, 7 cases not run (T07, T08 need `write_set`; the Slack and code-mode
cases need live tools), 0 not graded. The 6 misses are the fake target's two declared failures (N04, T05, 3 each).
Q01 and Q02 pass 3/3 each. Before: M2-G's dry run 3, 165/171.

## Conclusion

The harness carries both new cases and nothing else moved. The fake target only proves the cases are wired and graded
as intended; whether the real model asks in Q01 and finishes alone in Q02 is for the paid run.
