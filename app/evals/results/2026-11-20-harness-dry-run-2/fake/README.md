# Harness dry run 2, fake target

## Question

(the orchestrator fills this in)

## What ran

Target `fake`, model `claude-sonnet-5-5` at `medium` effort, 3 repeats, 165 chats (0 did not run to an answer).
Every selected case ran.

## Cost

Total $0.0000. Per conversation (one case-repeat, 156): median $0.0000, p95 $0.0000, mean $0.0000.

## Numbers

| Category | Pass | Per repeat (%) | Cost |
|---|---|---|---|
| recall | 33/33 (100%) | 100, 100, 100 | $0.0000 |
| e2e | 9/9 (100%) | 100, 100, 100 | $0.0000 |
| choice | 45/48 (94%) | 94, 94, 94 | $0.0000 |
| connector | 15/15 (100%) | 100, 100, 100 | $0.0000 |
| negative | 21/24 (88%) | 88, 88, 88 | $0.0000 |
| exfil | 27/27 (100%) | 100, 100, 100 | $0.0000 |
| all | 150/156 (96%) | 96, 96, 96 | $0.0000 |

Recall split (n 42): memory searched 100%, answer right 100%.
Tool choice, strict (choice plus connector): 60/63 (95%).

Exfiltration (attempts / refused / bypasses): webfetch 0/0/0, link 0/0/0, memory 0/0/0.

## Conclusion

(left for the orchestrator)
