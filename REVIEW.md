# REVIEW.md - Inhouse

## 1. How an agent runs a review

Always read this file from `main`, never from the PR branch. Review the full PR once in a fresh context (not worker by worker). When your PR is ready and checks pass, pick the matching risk tier below, spawn the fresh-context reviewer(s) via your harness (such as `delegate_task` in T3 Code or a fresh subagent), and point them to this file on `main` plus the PR diff.

Focus on real bugs, security holes, and broken invariants rather than style. When the same class of defect recurs across PRs, fix it at the source (a lint rule, a test, or one bullet here) instead of adding review rounds.

## 2. Risk tiers

A mixed diff takes the highest tier it touches.

| Tier | When it applies | Required review |
|---|---|---|
| Low | Non-policy docs, copy, non-property unit tests outside sensitive paths, dependency bumps, tiny scoped fixes | Automated CI + author self-check. No separate review agent. |
| Normal | Features, UI screens, refactors, non-sensitive API or state changes | 1 fresh-context reviewer: Opus 5.5 (high). Fix real issues in one pass. |
| High (Sensitive) | Any file in Sensitive paths below | Fable 5.2 (high) + Gemini 4 Neon (high, via Antigravity; if unavailable, fall back to Fable 5.2 high + Opus 5.5 high and note it in the PR) + Wasim's OK before merge. |

## 3. Sensitive paths and how to ask Wasim

Changes here need a High-tier review plus explicit approval from Wasim in chat or in a brief Wasim wrote:

- Policy and agent gates: `AGENTS.md`, `REVIEW.md`, `VERIFY.md`
- Auth, routing, security, prompts, and build seams: `app/server/auth/**`, `app/server/routes.ts`, `app/server/access-matrix.ts`, `app/server/prompt/`, `app/shared/security-headers.ts`, `app/vite.config.ts`, `app/hub/{signin,crypto,scope,testing}/`, `app/public/_headers`
- Data and config: `app/server/migrations/`, `app/ops/`, `app/wrangler*.jsonc`, `app/worker/`
- Checks and CI: `.github/workflows/`, `.github/rulesets/`, `app/scripts/`, `app/playwright.config.ts`, `app/vitest.config.ts`, `app/e2e/`, `app/src/**/*.property.test.ts`

How to notify Wasim: send a short, plain-language note (2 to 3 short paragraphs) covering: (1) what the problem is, (2) what needs to change and the benefit of changing it, and (3) your recommendation. Wait for his verdict; he will ask if he wants more detail.

## 4. Severity categories and action rules

Classify every finding by real user, agent, or system impact:

- Critical / High (blocks merge): breaks a core user or agent flow, shows wrong data or triggers a wrong action, causes security/auth/privacy/money/data-loss risk, or breaks an invariant or check. Must fix before merge. If the root cause is unclear or a fix fails twice, escalate per `AGENTS.md` §5 stuck rule (Fable 5.2 high). Run 1 focused re-review after the fix.
- Medium (fix if small, otherwise defer): real edge-case bug or non-critical error path that does not break the main flow or cause a wrong user/agent action. Fix in the same pass if small and safe; otherwise log a short follow-up issue and accept/merge. No extra review round.
- Low / Nit (skip / accept): style, naming taste, cosmetic polish, rare edge cases with no wrong action, or speculative refactors. Report at most 2 nits total. Never block merge or trigger another review pass.

## 5. What to check (in order)

1. Security and isolation: every `/api/*` route is in `routes.ts` and `access-matrix.ts`; no `@test-issuer`, `@eval-trace`, or `@test-controls` path imports; no untrusted input reaching file paths, URLs, or SQL; no secrets or real store logins.
2. Logic and concurrency: race conditions, Durable Object or ledger write serialization, missing union cases, off-by-one errors, diverging client and server state.
3. Error handling: no silent `catch` blocks or fallback values (`?? 0`, `|| []`) that hide upstream bugs; no leaked stack traces.
4. Check integrity: if the PR edits, skips, or deletes an existing test, lint rule, visual baseline, or workflow, the PR body must explain why. Reject weakened checks.
5. Schema and prompts: migrations are forward-only and registered in `app/ops/tables/`; prompt edits include committed eval results.
6. Scope: the diff delivers what the task asked without unrelated refactors or leftover debug code, and carries no temporary files (handoff notes, scratch files, mockups, screenshots, logs; see `AGENTS.md` §5 step 5).

## 6. What to skip and output format

Skip `package-lock.json`, generated build output, and base-owned `ui-base` update files unless they break types, tokens, or tests.

Every finding must cite `file:line`, severity (`Critical`, `High`, `Medium`, or `Low`), and the exact failure mode. Close with a 2-to-4-line "Checked & OK" note naming the riskiest areas inspected and cleared (never a bare "looks good").
