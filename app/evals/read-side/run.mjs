#!/usr/bin/env node
// The read-side set's command line: one dispatch is one model, one report. See README.md ("Running it") and cli.ts.
//
//   node evals/read-side/run.mjs --target fake|product --model <api id> --out <dir> [--page-origin <https origin>] [--paid --budget <usd>]
//     [--agent honest|obedient] [--cases RS-SF1,RS-LW1] [--sha <git sha>]
//
// Exit: 0 every required cell ran and passed with zero bypasses; 1 a graded case failed, or required cells did not run (listed
// apart, never counted as passed); 2 invalid invocation, a budget or cap stop, an infrastructure error or a write failure.
import { main } from './cli.ts'

process.exit(await main(process.argv.slice(2)))
