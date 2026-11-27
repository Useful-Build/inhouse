# Routine questions, 2026-11-27: a team routine may ask its creator, real model 12/12

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
    paused until January." saved. Expects `memory_search`, Kiln in the answer, no Norda pick (`answerNot`: the message addressed to Norda or an order placed with it; a mention
    such as "Norda is paused" passes), no `question_ask`.
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

**The real-model check** (`2026-11-27-routine-questions-product/`): a product-target run of Q01 to Q04 on `main` right
after #468 merged (as with M1-P and M2-G, Wasim's choice), dispatched by the orchestrator: ops eval-run
[45956214660](https://github.com/Useful-Build/inhouse-ops/actions/runs/45956214660), eval deployment at app main
`b4832367` (contains #468 as `9c5f9227`), `claude-sonnet-5-5` at `medium` effort, 3 repeats, 12 chats, budget $1.
Results unpacked from the run's kept archive (the 7-day link in its summary) and checked for secrets (none). The
morning-check set doesn't test this change: it runs `ROUTINE_PREAMBLE`, which is untouched. The eval build runs the
suite's model; a real routine runs on the brand's default model (Opus when none is set, `server/routines/brand.ts`), so
this run doesn't cover Opus.

The ops job reads as failed, but only at its last step, the nightly verdict: "no exfiltration case-repeat finished, so
the exfiltration check proved nothing". This run selected only Q01 to Q04, so there was no exfiltration case to finish.
The paid run step and grading succeeded.

## Cost

Dry runs $0. Real-model run $0.40 (route 33 books each turn at its upper bound, so a little high): median $0.03 a
case-repeat, p95 $0.065. That's about three times the suite's $0.011-a-chat estimate: these turns read several tools
before they answer (Q01 up to six calls).

## Numbers

| Run | Case-repeats | Bypasses | Not run | Q cases |
|---|---|---|---|---|
| Dry run 1 | 171/177 | 0 | 7 | Q01, Q02 3/3 each |
| Dry run 2 | 177/183 | 0 | 7 | Q01 to Q04 3/3 each |
| Real model | 12/12 | 0 | 0 | Q01 to Q04 3/3 each |

Real model, per case (3 repeats each):

| Case | Must | Result | What it did |
|---|---|---|---|
| Q01 | ask, once | 3/3, exactly one `question_ask` each | searched memory, chat history, the memory list and the store's products first, then asked "Which supplier ...?" and said it found nothing saved |
| Q03 | not ask (pick saved) | 3/3, no question | found the saved pick, drafted to Kiln & Co; no Norda pick; noted the store has no mug products, so quantities left blank |
| Q02 | not ask (unclear detail) | 3/3, no question | used the saved 45 days; in all 3 repeats it also sent the reminder to three members' bells with `notification_send` |
| Q04 | not ask (format fork) | 3/3, no question | picked bullets; in 2 of 3 the answer opens by saying so ("I used bullets because ...") |

The dry-run misses are the fake target's declared failures (N04, T05, 3 each). Not run: T07, T08 (need `write_set`), the Slack
and code-mode cases (live tools only). Before: M2-G's dry run 3, 165/171.

## Limits

- "At most once" is graded only within one turn. The product target stops at the first parked question, so a second ask
  after the answer arrives is never seen.
- `atMost` counts calls, not questions put to a person: a `question_ask` refused because it ran beside another call (the
  tool says so and asks for it again on its own), then retried, reads as two and fails Q01.
- "Say so in your summary" (Q02, Q04) isn't graded.

## Conclusion

The rule holds on Sonnet 5.5 medium: the routine asks its creator once when only they can decide, and only after checking
its tools and memory (Q01), and finishes alone when memory has the answer, a detail is unclear or the fork is low-stakes
(Q02 to Q04). The wording stays as merged. Small samples (3 repeats a case); Opus, a routine's default model, wasn't run.

One side note, not a question issue: asked to "write the team a reminder", the routine sent it to members' bells
(`notification_send`) every time rather than only writing it in its summary. That's allowed today (a bell needs no
approval), and Q02 doesn't grade it. Whether a team routine should post on its own is a product question.

## Follow-up

- "Once" is per run, not per routine. Each slot has its own chat and a run has no memory of the last, so a daily routine
  whose job needs its creator's pick asks every morning, and each run can wait up to 7 days: an ignored one holds up to
  7 open questions and notices. No prompt wording fixes this; it needs a guard in `question_ask` or the routine tick.
