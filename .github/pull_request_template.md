## Summary

<!-- What changed and why, in a few lines. Link the plan or issue. -->

## Risk tier

<!-- Low, Normal, or High (Sensitive) per REVIEW.md on main. -->

## Changed existing checks

<!-- Every spec, baseline, property test, lint rule, workflow or ruleset this PR changes, each with the reason.
pr-gates flags them. Write "None" if there are none. -->

- None

## Screenshots

<!-- For a UI change: before and after, light and dark, desktop (1440x900) and phone (390x844).
Changed visual baselines show in the diff; say why each one moved. Delete this section for a change with no UI. -->

## Verification & live QA

<!-- What automated checks you ran and what they showed, plus targeted live QA proof (e.g., Live QA: PASS - ...) for user-facing or agent-behavior changes per VERIFY.md. -->

## Commit trailers

Every commit ends with a paragraph that holds only trailers, one of them `Verified:`, saying how it was checked.
No other text goes in that paragraph, or git won't read it as trailers and `pr-gates` fails. For example:

```
fix(app): keep the draft when a chat is renamed

Verified: chats-manage.spec.ts on desktop and phone; tsc, lint
Co-Authored-By: Name <email>
```
