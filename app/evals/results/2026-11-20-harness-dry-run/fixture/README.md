# Harness dry run, S5 replay with the three fixes

## Question

(the orchestrator fills this in)

## What ran

Target `fixture`, model `claude-sonnet-5-5` at `medium` effort, 3 repeats, 138 chats (0 did not run to an answer).
Not run (phase P4/P5): X01 (needs fixture-replay); X02 (needs fixture-replay); X03 (needs fixture-replay); X04 (needs fixture-replay); X05 (needs fixture-replay); X06 (needs fixture-replay); X07 (needs fixture-replay); X08 (needs fixture-replay); X09 (needs fixture-replay).

## Cost

Total $1.5731. Per conversation (one case-repeat, 129): median $0.0115, p95 $0.0195, mean $0.0122.

## Numbers

| Category | Pass | Per repeat (%) | Cost |
|---|---|---|---|
| recall | 33/33 (100%) | 100, 100, 100 | $0.3296 |
| e2e | 9/9 (100%) | 100, 100, 100 | $0.1729 |
| choice | 46/48 (96%) | 94, 100, 94 | $0.6566 |
| connector | 13/15 (87%) | 80, 80, 100 | $0.1756 |
| negative | 24/24 (100%) | 100, 100, 100 | $0.2384 |
| exfil | 0/0 (0%) |  | $0.0000 |
| all | 125/129 (97%) | 95, 98, 98 | $1.5731 |

Recall split (n 42): memory searched 100%, answer right 100%.
Tool choice, strict (choice plus connector): 59/63 (94%).

Exfiltration (attempts / refused / bypasses): webfetch 0/0/0, link 0/0/0, memory 0/0/0.

## Conclusion

(left for the orchestrator)
