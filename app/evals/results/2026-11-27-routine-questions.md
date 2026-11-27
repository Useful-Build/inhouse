# Routine questions, 2026-11-27: a team routine may ask its creator, dry runs only so far

## Question

A team routine's turn opened with "Don't ask questions". That contradicts M2-Q (`question_ask` sends a routine's
question to its creator, else every admin; N16) and M2-J's sandbox scenario, which proves that plumbing. Wasim approved
the change on 2026-11-27: a routine runs unattended, so it finishes on its own whenever it can, and asks its creator
only when it can't do the job correctly without a decision only they can make, at most once, short with clear options.

Does a routine ask when it must, and finish alone when it can (a saved answer, an unclear detail, a low-stakes fork)?

## What changed

- `server/prompt/routines/common.ts`: `TEAM_ROUTINE_PREAMBLE` drops "Don't ask questions" for the rule above, plus
  "where something is unclear but a sensible choice exists, make it and say so in your summary". `teamRoutineTurn` (new)
  builds a team routine's turn text, used by `server/routines/prompts.ts` and the eval cases, so the two can't drift.
  `ROUTINE_PREAMBLE` (system routines, the morning check v1) is unchanged: its result is structured and never waits on a
  person.
- No version to raise: the team preamble is turn text kept per run on its slot, not the system prompt
  (`SYSTEM_PROMPT_VERSION` stays 5), and `MORNING_CHECK_PROMPT_VERSION` stays 1 because its text didn't change.
- Four eval cases in `app/evals/cases.ts`, each the exact turn text a team routine sends, run as a chat turn (a question
  reaches the case's person in place of the routine's creator):
  - **Q01** (choice): "Draft this week's mug reorder message to the supplier we're ordering from this week, Norda or
    Kiln & Co. It changes from week to week." Nothing saved about it. Expects `question_ask`, at most one call
    (`atMost`, new in `grade.ts`); not `AskUserQuestion`, `approval_request` or `notification_send`.
  - **Q03** (negative), Q01's minimal pair: the same text, with "This week's mug reorder goes to Kiln & Co. Norda is
    paused until January." saved. Expects `memory_search`, Kiln in the answer, no `question_ask`.
  - **Q02** (negative): "Write the team a short reminder of our return window for the holiday season." The 45-day
    window is saved, nothing about the holidays. Expects `memory_search`, 45 in the answer, no `question_ask`.
  - **Q04** (negative), a low-stakes fork: a note on our shipping rules "as a short paragraph or as bullet points. I
    haven't decided which." Expects `memory_search`, 60 in the answer, no `question_ask`.

## What ran

From `app/`, target `fake` (canned transcripts, no model; the report's `claude-sonnet-5-5` label is the harness default,
not a model that ran), 3 repeats, $0:

- **Dry run 1** (`2026-11-27-routine-questions-dry-run/`), PR #468's first commit 028d5de5, Q01 and Q02 as first written:
  `node evals/run.ts --target fake --out evals/results/2026-11-27-routine-questions-dry-run --topic "Routine questions dry run"`.
- **Dry run 2** (`2026-11-27-routine-questions-dry-run-2/`), after the round-1 reviews (Fable, Neon): the four cases
  above, on the tree of #468's second commit:
  `node evals/run.ts --target fake --out evals/results/2026-11-27-routine-questions-dry-run-2 --topic "Routine questions dry run 2 (review round 1)"`.

The fake target never reads the prompt: these runs prove the cases are wired and graded, nothing about the rule.

**The real-model check** is a product-target run of Q01 to Q04 on `main` right after merge (as with M1-P and M2-G,
Wasim's choice), dispatched by the orchestrator (about $0.13 at the suite's $0.011 a chat, cap $1), with its results in
a follow-up. The morning-check set doesn't test this change: it runs `ROUTINE_PREAMBLE`, which is untouched. The eval
build runs the suite's model (Sonnet 5.5 medium); a real routine runs on the brand's default model (Opus when none is
set, `server/routines/brand.ts`).

## Numbers

| Run | Case-repeats | Bypasses | Not run | Q cases |
|---|---|---|---|---|
| Dry run 1 | 171/177 | 0 | 7 | Q01, Q02 3/3 each |
| Dry run 2 | 177/183 | 0 | 7 | Q01 to Q04 3/3 each |

The misses are the fake target's declared failures (N04, T05, 3 each). Not run: T07, T08 (need `write_set`), the Slack
and code-mode cases (live tools only). Before: M2-G's dry run 3, 165/171.

## Limits

- "At most once" is graded only within one turn. The product target stops at the first parked question, so a second ask
  after the answer arrives is never seen.
- "Say so in your summary" (Q02, Q04) isn't graded.

## Conclusion

The cases are wired and discriminate on paper: a canned double ask fails Q01, any ask fails Q02 to Q04. Whether the real
model asks in Q01 and finishes alone in Q02 to Q04 is the post-merge run's question. If Q03 fails (it asks although the
pick is saved), the wording fix is "only when, after checking your tools and brand memory, you can't ...".

## Follow-up

- "Once" is per run, not per routine. Each slot has its own chat and a run has no memory of the last, so a daily routine
  whose job needs its creator's pick asks every morning, and each run can wait up to 7 days: an ignored one holds up to
  7 open questions and notices. No prompt wording fixes this; it needs a guard in `question_ask` or the routine tick.
