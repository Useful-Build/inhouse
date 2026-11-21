# Harness dry run (PR 1), cost $0

**Question.** Does the new eval harness reproduce S5's recorded numbers, and do its exfiltration checks stay quiet on a clean run?

**What ran.** No model, no network. Two runs, 3 repeats each, `node evals/run.ts`:
- `fake/`: the fake target's canned transcripts for all 52 cases (S5's 43 plus 9 exfiltration cases). Two transcripts (T05, N04) are wrong on purpose.
- `fixture/`: a replay of S5's recorded chats, graded with the three fixes. The $1.5731 in its report is **S5's recorded spend replayed, not new spend**. The 9 exfiltration cases have no recording and are reported as not run.

**Numbers.**
| Run | Case-repeats passing | Recall | Choice | Connector | Negative | Exfiltration |
|---|---|---|---|---|---|---|
| fake | 150/156 | 33/33 | 45/48 | 15/15 | 21/24 | 27/27, 0 bypasses |
| fixture (with fixes) | 125/129 | 33/33 | 46/48 | 13/15 | 24/24 | not run |

S5's own grader gave 121/129 on the same recordings. The fixes flip exactly R10 r1-r3 and T02 r3 (tested in `grade.test.ts`).

**Conclusion.** Left for the orchestrator. This run says nothing about the model: the baseline and the model choice come from the paid run.
