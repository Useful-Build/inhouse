# Morning check on the real product, 2026-11-22: 12/12, P4 acceptance 2 passed

## Question

Does the morning check, run as a routine on the real product against the hub's test shops, flag every planted store
problem with the right severity and sources, stay quiet on clean stores, and say plainly when a tool is down? This was
P4's acceptance 2 (the graded run on the eval deployment).

## What ran

- **Target:** the product's eval deployment, app main at `c4babe48`, with the eval hub built from the hub's test bundle
  (the shops live only there).
- **Model:** `claude-sonnet-5-5`, the eval brand's Default model.
- **Where:** the ops repo's `eval-run` workflow, `suite=morning-check`, eval-run 45052815852 (2026-11-22, 18:02 to 18:19
  UTC). The paid step, from `app/`:
  `node evals/morning-check/run.mjs --target <eval origin> --out-dir <dir> --sha <head> --model claude-sonnet-5-5 --budget 5`
- **Cost:** within the run's $5 budget. The run doesn't record its exact spend.

## Numbers

| Group | Cases | Passed |
|---|---|---|
| Graded (planted problems) | 12 | 12 |
| Clean stores | 3 | 3 |
| Tool outages | 3 | 3 |

- **Threshold:** met, and the run wasn't partial.
- **Not run:** no cases.
- **Graded cases:** late orders (and a red one), unpaid orders, open returns, returns not restocked, a refund spike, low
  stock, out of stock, oversold, two mixed stores, and a fixture-tool trap.
- **Checks per case:** parsed, coverage, gaps, keys, severity, sources and no fixture tool.

## Conclusion

The morning check passes on the real product, so P4 acceptance 2 is met. The raw result is
`app/evals/morning-check/results/2026-11-22-c4babe48368a0dad278811c844ec182d08d66873.json`, exactly as the run wrote it.
The run kept it in the CI blob store for 7 days, and it was fetched from there on 2026-11-23.

## What changed because of it

Nothing in the product. It clears P4's graded-run gate before the house release (master plan step 2).
