# Morning check, 2026-11-27: all 18 cases pass, the first complete run since #380

## Question

Does the morning check (prompt v1, unchanged since its graded run) still pass its whole set on the real model, now that
#470 lets the outage cases run? M1-P's run (2026-11-26) stopped before the three outage cases, because `outage-all`
needed Shopify connected on the eval brand. It also stands as the morning-check check for the prompt changes since:
M2-G's system prompt v5 (#454) and #468's team routine preamble. Neither touches `ROUTINE_PREAMBLE` or the morning check's
text.

## What ran

ops eval-run [45959485009](https://github.com/Useful-Build/inhouse-ops/actions/runs/45959485009), 2026-11-27 07:36 to
07:50 UTC, on the eval deployment at app main `7740b8e9` (after #470): `run.mjs` with `claude-sonnet-5-5` and a $5
budget. Every case ran on `claude-sonnet-5-5` (its slot's `ranOn`) with system prompt v5 and Shopify named as connected.
The run leaves the eval brand's Default model on Fast (Sonnet 5.5), as its last line says.

Result file: `../morning-check/results/2026-11-27-7740b8e93669a2cba986d99747d1b2228173d6d6.json`, unpacked from the
run's kept archive (the 7-day link in its summary) and checked for secrets (none).

## Cost

The exact spend isn't recorded. Neither the result file nor the job log prints it. `run.mjs` reads the eval brand's
month total on route 42 to stop at its budget but doesn't write the difference out, so the run spent at most $5 plus
one case's spend. Only an ops run can read route 42. To record it next time, `run.mjs` should print the route 42
difference at the end (a small follow-up).

## Numbers

**18/18 cases pass, threshold met, not partial.**

| Group | Pass | Cases |
|---|---|---|
| graded | 12/12 | the eight problem kinds plus late-orders-red (1 item each); mixed-a, mixed-b and fixture (3 items each) |
| clean | 3/3 | clean-old-orders, clean-steady, clean-empty: 0 items each |
| outage | 3/3 | outage-all (no items, every area a gap), outage-credentials (orders and refunds gaps, 1 item from the reads that worked), outage-too-large (returns gap, 1 item) |

The 18 cases took 10.4 minutes of run time in all (24 to 58 s each).

## Conclusion

This is the first complete run of the set (all 18 cases, outage included) since the 2026-11-22 baseline (`c4babe48`),
before #380 (2026-11-24). M1-P's run of 2026-11-26 (`09eddce5`) passed 15/15 but was partial. The morning check v1
holds on main with system prompt v5, and a failed read is still a gap, never an item.
