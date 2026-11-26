# Capability eval skeleton dry run (grader check only, not a capability result)

## Question

Do the three M1-H capability graders (`CAP-01`, `CAP-02`, `CAP-03`) pass their positive fake-target fixtures and reject every negative and near-miss fixture?

## What ran

Target `fake`, model `claude-sonnet-5-5` at `medium` effort, 3 repeats, 9 chats (0 did not run to an answer).
Every selected case ran.

## Cost

Total $0.0000. Per conversation (one case-repeat, 9): median $0.0000, p95 $0.0000, mean $0.0000.

## Numbers

| Category | Pass | Per repeat (%) | Cost |
|---|---|---|---|
| recall | 0/0 (0%) |  | $0.0000 |
| e2e | 9/9 (100%) | 100, 100, 100 | $0.0000 |
| choice | 0/0 (0%) |  | $0.0000 |
| connector | 0/0 (0%) |  | $0.0000 |
| negative | 0/0 (0%) |  | $0.0000 |
| exfil | 0/0 (0%) |  | $0.0000 |
| all | 9/9 (100%) | 100, 100, 100 | $0.0000 |

Recall split (n 0): memory searched 0%, answer right 0%.
Tool choice, strict (choice plus connector): 0/0 (0%).

Exfiltration (attempts / refused / bypasses): webfetch 0/0/0, link 0/0/0, memory 0/0/0.

## Negative and near-miss grader checks

Verified in `app/evals/capability/grade.test.ts` (all rejected):
- `CAP-01`: bare `"Done."` (`bare_done_answer`), wrong facts in `Write` content (`missing_file_facts`), and an early good `Write` overwritten by a later bad `Write` (`missing_file_facts`).
- `CAP-02`: bare `"Done."` without `Agent` (`bare_done_answer`), and inverted glaze/shipping facts (`missing_source_facts`).
- `CAP-03`: bare `"Done."` (`bare_done_answer`), foreign source URL (`foreign_source_url`), and official `europa.eu` `WebFetch` with no citation URL in the answer (`missing_source_url`).

## Conclusion

Grader check only, not a capability result (no model calls, $0.0000). On the fake target, `gradeCapabilityEndState` grades the final `Write`/`Edit` input until M6 wires stored-file retrieval from the product target. `CAP-01..03` declare `needs: ['capability']` so `product` runs report them as not run until M6.
