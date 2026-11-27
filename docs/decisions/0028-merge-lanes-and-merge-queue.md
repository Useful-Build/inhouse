# 0028. Merge lanes, a merge queue, and narrow re-runs

- Status: accepted, 2026-11-27
- Replaces: parts of [0010](0010-integration-branch-per-project.md) (integration branch by default), [0013](0013-rulesets-as-committed-json.md) (no merge queue, branch up to date) and [0016](0016-ship-recording-and-exact-sha-approval.md) (exact-SHA approval of every final PR)
- Rules: `AGENTS.md` §5, `REVIEW.md` §2 to §4, `VERIFY.md` §4 ("Re-runs")

## Context

In 9 days (2026-11-18 to 11-26, 1,538 `ci` runs), agents asked Wasim for an OK about 270 times across about 34 PRs, most of them green. `REVIEW.md`'s sensitive list decided both "strongest review" and "Wasim's OK", and by 11-26 it covered most of the code, tests included. Standing approvals were time-boxed and lapsed. An approval was bound to one commit, so a test-only fix voided it.

Re-runs cost more than the tests. 38% of runs were cancelled by a new push. "Update with main" re-runs took 29% of the CI minutes on PRs into main. Agents dispatched 84 full runs, 37 repeating a green fast run, and about 44 more full runs followed failures of only 1 to 3 tests, because CI had no way to run just a few browser tests and the laptop runs none. Final fleet PRs waited a median 64 minutes from first green to merge.

## Decision

1. **Four lanes** (`REVIEW.md` §2): Low and Normal as before. High (two strong reviewers) merges without a human. Only Lane 4 needs Wasim: the referee (CI, configs, check scripts, any check-weakening), the rules, secrets and trust boundaries, money and irreversible steps, and the plan. His yes is the `wasim-approved` label, and it carries over pushes that touch no Lane 4 item.
2. **A Gate ledger** in each milestone plan (routes, write operations, egress hosts, migrations), approved once with the plan. Both High reviewers confirm each ledger item with a `Gate check:` line.
3. **The `gate` check** runs `main`'s rules on every PR from the API (no PR code runs) and enforces the label and the ledger lines.
4. **A merge queue on `main`**, with "branch up to date" off. Auto-merge is armed only after reviews on the exact head and switched off before any later push.
5. **Trunk by default.** Work lands straight into `main` in small PRs. `fleet/<topic>` is only for work that must land all at once. A milestone ends with one message to Wasim: its ship reel plus the next plan and ledger. That's a review, not a merge gate.
6. **Narrow re-runs** (`VERIFY.md` §4): fix with targeted runs (`targeted.yml`, `--last-failed`), prove once with the pipeline's own full run, and sort failures as infra, real or flaky by facts.
7. **A 3-round review cap**: a full review, then a check of the fix by the reviewer who raised each finding, then a fresh Fable 5.2 (xhigh) that fixes or dismisses. Its call is final.

## Consequences

- Wasim's attention goes where his judgment changes the result. In a sample of 10 PRs from 11-26, 4 would still have needed him, instead of 10.
- Because every agent pushes as the owner's account, the label is honour-based but recorded, and the `gate` check catches every Lane 4 path. Giving agents their own GitHub identity, so his yes becomes a real GitHub review, is the next step.
- A rollback holds only until the next merge, so recovery is a rollback as a stopgap, then a revert PR through the queue.
- Merging into `main` deploys only the public demo (0019). Brand releases stay a separate, human-run step in the ops repo. Revisit this decision before Stage 2's live deploys.
- Proposal, data and the two outside reviews (Fable 5.2 xhigh, Gemini 4 Carbon high) that shaped it: the "Green Means Go" page, walked through with Wasim part by part on 2026-11-26 and 11-27.
