# REVIEW.md - Inhouse

## 1. How an agent runs a review

Always read this file from `main`, never from the PR branch. Review the full PR once in a fresh context (not worker by worker). When your PR is ready and checks pass, pick its lane below, spawn the fresh-context reviewer(s) via your harness (such as `delegate_task` in T3 Code or a fresh subagent), and point them to this file on `main` plus the PR diff. Reviewers post their verdict on the PR as a comment.

Focus on real bugs, security holes, and broken invariants rather than style. When the same class of defect recurs across PRs, fix it at the source (a lint rule, a test, or one bullet here) instead of adding review rounds.

## 2. Lanes

The lane decides how strong the review is and whether Wasim is needed. A mixed diff takes the highest lane it touches. The `gate` check (`.github/workflows/gate.yml`, run from `main`'s code) reports each PR's lane and its Lane 4 items; it can't tell Lane 1 from Lane 2, so the author picks between those two. Decision [0028](docs/decisions/0028-merge-lanes-and-merge-queue.md).

| Lane | When it applies | To merge | Who merges |
|---|---|---|---|
| 1. Low | Non-policy docs, copy, non-property unit tests outside the paths in §3, tiny scoped fixes | CI green + author self-check | Auto-merge |
| 2. Normal | Features, UI screens, refactors, non-sensitive API or state changes | CI green + 1 fresh-context Opus 5.5 (high) review with no open Critical/High + live QA noted (user-facing) + `FEATURE_MAP.md` updated | Auto-merge |
| 3. High | Any Lane 3 path (§3), with no Lane 4 item | CI green + Fable 5.2 (high) and Gemini 4 Neon (high, via Antigravity; if unavailable, Fable 5.2 high + Opus 5.5 high, noted in the PR), both with no open Critical/High, and each writing `Gate check: on ledger` when the PR has ledger items (§3) | Auto-merge |
| 4. Wasim's OK | Any Lane 4 item (§3) | Everything Lane 3 needs + Wasim's yes, recorded as the `wasim-approved` label | Auto-merge, armed after his yes |

Auto-merge is armed only after the lane's reviews (and live QA, where needed) are done on that exact head: `gh pr merge <n> --auto --match-head-commit <sha>` (the merge queue sets the method). Before any later push, run `gh pr merge <n> --disable-auto`, push, and earn it again.

## 3. Lane 3, Lane 4 and the Gate ledger

**Lane 3 paths** (two strong reviewers, no human): `app/server/egress/`, `app/server/permissions/`, `app/server/outbox/`, `app/server/usage/`, `app/server/notify-slack/`, `app/server/do/brand-agent/`, `app/hub/outbox-entry/`, `app/hub/connectors/*/write/`, `app/server/prompt/` (with committed eval results), `app/server/migrations/`, `app/server/routes.ts` and `app/server/access-matrix.ts` (ledger items, below), the rest of `app/ops/`, and new or changed `app/e2e/` specs and `*.property.test.ts` files (weakening one is Lane 4).

**Lane 4: Wasim's OK.** A PR is Lane 4 if it touches any of these:

1. The referee: `.github/` (workflows, rulesets), `app/playwright.config.ts`, `app/vitest.config.ts`, lint configs (`app/.oxlintrc.json`), every `tsconfig*.json`, an existing check script in any `scripts/` folder of `app/`, `app/hub/` or `app/runner/`, a change to a `package.json` `scripts` entry (the lint, typecheck and test commands), or any check-weakening change anywhere: a deleted test, a skipped test or suite (`test.skip('title', ...)`, `describe.skip`, a bare `test.skip()`, the same with `.fixme`), a lint-disable comment, a raised pixel threshold, timeout or retry count or fewer property runs on an existing test or assertion, or a net loss of tests. Adding or tightening tests is not Lane 4, and neither is a conditional skip (`test.skip(!phone(page), ...)`, `test.skip(!process.env.E2E_TEST_BUILD_REMOTE, ...)`), which only says where a test runs. Changing an expectation or baseline because planned behavior changed is not check-weakening; the PR body lists each one (§5.4).
2. The rules: `AGENTS.md`, `REVIEW.md`, `VERIFY.md`, `docs/decisions/`. Every edit.
3. Secrets and trust boundaries: `app/scripts/sandbox/` (its token reaches the Cloudflare account), `app/server/auth/`, `app/hub/{signin,crypto,scope,testing}/`, `app/runner/src/guards/`, `app/runner/src/proxy/`, `app/shared/security-headers.ts`, `app/public/_headers`, `app/vite.config.ts`, `app/wrangler*.jsonc`, `app/worker/`, backup, restore, retention, export, deletion and teardown jobs in `app/ops/`, and any dependency change, including packages a Dockerfile installs (until the jobs that hold secrets install with `--ignore-scripts`; then version bumps drop to Lane 1 and only new dependencies stay here).
4. Money and irreversible steps: paid runs past an approved cap, a migration that isn't purely additive, deploys to a brand or house account, real outbound messages, deleting data.
5. The plan: a deviation from the approved plan, a ledger item that isn't on the ledger, or a prompt change whose eval results fall below the committed baseline.

**The Gate ledger.** Each milestone plan lists what it will add that would otherwise need Wasim: routes with their `access-matrix.ts` row, write operations, egress hosts and migrations. Wasim approves the ledger once, with the plan. A PR whose ledger items are all on the approved ledger stays in Lane 3; both High reviewers check that and write `Gate check: on ledger` (or `Gate check: off ledger: <item>`, which makes the PR Lane 4). The `gate` check fails a PR with ledger items until two such lines are on it. The lines cover the PR as a whole: after a push that adds a ledger item, both reviewers confirm again.

**How to ask Wasim.** Lane 4 items never stop other work: build them, note them, and bring them in one batch (about 10 to 15 open items, or sooner if a batch is ready to merge), in the orchestrator thread. Anything that blocks other work goes to him at once, on its own. Each item: a short plain note (what changed, why, the benefit, your recommendation), options first. His yes is recorded on the PR: the `wasim-approved` label plus a comment line `wasim-approved: <head sha he approved>`, with his message quoted.

**Approval carry-over.** An approval covers the content Wasim approved, not one commit. After a later push, the `gate` check compares the files changed since the approved head; if they hold no Lane 4 item, the approval stands. If they do, or the PR's base branch changed after the approval, it's stale: remove the label and ask again.

## 4. Severity, action rules and the review cap

Classify every finding by real user, agent, or system impact:

- Critical / High (blocks merge): breaks a core user or agent flow, shows wrong data or triggers a wrong action, causes security/auth/privacy/money/data-loss risk, or breaks an invariant or check. Each needs a concrete failure scenario (this input or state, that wrong result); without one it's Medium at most.
- Medium (fix if small, otherwise defer): real edge-case bug or non-critical error path that does not break the main flow or cause a wrong user/agent action. Fix in the same pass if small and safe; otherwise log a short follow-up issue and merge. Never a reason for another round.
- Low / Nit (skip / accept): style, naming taste, cosmetic polish, rare edge cases with no wrong action, or speculative refactors. Report at most 2 nits total.
- A problem in code the PR didn't change is a follow-up issue, not a blocker, unless the PR makes it reachable.

**Review rounds (at most 3):**

1. Full review by the lane's reviewers.
2. After the fix, only the reviewer who raised each Critical/High finding checks only the commits since round 1 and confirms their own findings are closed. A new finding is allowed only if it's Critical/High and the fix caused it. Once every reviewer has approved, there are no more rounds.
3. If a Critical/High finding is still open, a fresh Fable 5.2 (xhigh) gets the finding, the diff and both sides' notes, and decides. Real: Fable fixes it itself. Not real: dismissed with a written reason on the PR. Its call is final.

If Fable can't settle it, stop and send Wasim the short stuck report (`AGENTS.md` §5.5).

## 5. What to check (in order)

1. Security and isolation: every `/api/*` route is in `routes.ts` and `access-matrix.ts`; no `@test-issuer`, `@eval-trace`, or `@test-controls` path imports; no untrusted input reaching file paths, URLs, or SQL; no secrets or real store logins.
2. Logic and concurrency: race conditions, Durable Object or ledger write serialization, missing union cases, off-by-one errors, diverging client and server state.
3. Error handling: no silent `catch` blocks or fallback values (`?? 0`, `|| []`) that hide upstream bugs; no leaked stack traces.
4. Check integrity: if the PR edits, skips, or deletes an existing test, lint rule, visual baseline, or workflow, the PR body must explain why. Reject weakened checks.
5. Schema and prompts: migrations are forward-only and registered in `app/ops/tables/`; prompt edits include committed eval results.
6. Scope: the diff delivers what the task asked without unrelated refactors or leftover debug code, and carries no temporary files from the work (handoff notes, scratch files, temporary mockups or screenshots, logs; see "Clean before review" in `AGENTS.md` §5).
7. Lane: the PR's lane is right, and for Lane 3 every ledger item is on the approved ledger.

## 6. What to skip and output format

Skip `package-lock.json`, generated build output, and base-owned `ui-base` update files unless they break types, tokens, or tests.

Every finding must cite `file:line`, severity (`Critical`, `High`, `Medium`, or `Low`), and the exact failure mode. Close with a 2-to-4-line "Checked & OK" note naming the riskiest areas inspected and cleared (never a bare "looks good"), plus the `Gate check:` line when the PR has ledger items.
