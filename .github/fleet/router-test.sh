#!/usr/bin/env bash
# Runs the router and the task and outcome steps against fixtures/ and compares what they decide
# and what they would change with fixtures/expected.txt. Needs bash, jq and nothing else: no
# network, no GitHub token.
#
#   router-test.sh   compare, exit 1 and show the diff on any difference
#
# expected.txt is written by hand from the rules (starts and caps, the PR states, the final PR),
# never generated from this code's output. There is deliberately no option to rewrite it: a test
# that blesses whatever the code prints can't catch a wrong decision. When a rule changes, edit
# expected.txt by hand from the rule first, then change the code until this passes.
#
# Decision lines are compared without their free-text reason ("#104 start pr=failing", not
# "#104 start pr=failing: unfinished, ..."): the decision, the PR state word and the commands are
# what's under test. The PR state is kept so two states that both lead to "start" can't hide a
# wrong rule. The clock is fixed at 2026-11-17T12:00:00Z, and the job cap at 25 with 2 task runs
# active, so the 23 starts before #130 fill it exactly. One issue per case in fixtures/issues.json:
#   101 running            102 merged               103 in the merge queue, no auto-merge object
#   104 auto-merge on, checks failed                105 stopped, with a queued run
#   106 fleet:failed       107 auto-merge on, checks passing
#   108 ready, checks pending, no auto-merge        109 written by someone else
#   110 blocked            111 ready, auto-merge off, passing, not queued (dropped from the queue)
#   112 closed-only PR with a stale auto-merge object
#   113 fork PR named task/113, auto-merge on, checks passing; forged markers
#   114 PR into the wrong base                      115 exactly 5 starts, done among them
#   116 6 starts, done among them                   117 one failed; no Base line
#   118 failed, progress, failed                    119 failed, paused, failed
#   120 paused, retry_after past   121 paused, retry_after empty   122 paused, impossible date
#   123 paused on a, retry_after future             124 null user
#   125 owner login in another case, locked         126 draft PR
#   127 merged but stopped         128 a PR in the issue list      129 its API reads fail
#   131 fork PR named task/131, merged              132 auto-merge on, checks ERROR
#   133 auto-merge on, checks passing, conflicting  134 paused on a, rotation at a: goes to b
#   135 all three seats paused     136 b and c paused, a paused 30 minutes ago with no retry_after
#   137 c and b paused, a paused 2 hours ago with no retry_after
#   138 b and c paused, a paused until exactly now  139 markers listed out of time order
#   140 merged, the only task naming fleet/closing  141 its lock fails
#   142 5 starts, PR with auto-merge on             130 (created last) no free job slot
#   143 progress on c, then cancelled on a: only the progress moves the rotation, so a
#   144 paused on b 30 minutes ago, retry_after unreadable: b is blocked for an hour, so c
#   141 is created first, so its failed lock comes before the slots run out.
# after-run/: a round a task run started, with that run's id. Tasks 160 to 163 each have a run in
# progress (9160 to 9163). 160's run just recorded progress on a; 162's just paused on b until
# 13:00 (its own run starts no round, but any round must still skip that seat); 163's just failed
# for the second time in a row. Only the named run is left out.
# Waiting for dispatched runs: 9001 is in runs.json; 9150 isn't, and has finished; 9151 isn't,
# though reading it by id says it's in progress (the list lags); 9152 can't be read at all.
# The budget: rate_limit.json leaves 200 REST requests, exactly the default floor, and 960
# GraphQL points, so the main round runs as usual. With the floor at 201 the same round starts
# nothing, closes nothing and opens no final PR, and is green; a fleet:stop event still cancels.
# A floor that isn't a number fails a round red, but a fleet:stop event still cancels, green.
# after-run/ leaves 731 REST and exactly 200 GraphQL, so its rounds run. graphql-low/ has only
# rate_limit.json: 900 REST, 199 GraphQL, so the round holds back before it reads anything else.
# final.json: fleet/done ready, fleet/demo has open tasks, fleet/has-pr has a PR into main,
# fleet/empty isn't ahead of main, fleet/closing is ready once #140 closes this round, though the
# lists read again still have #140 open and not closed (GitHub's lag), fleet/orphan is ahead with
# no task naming it, fleet/reviewed has a closed PR into main at its current head, fleet/reworked
# has one at an older head. A close that fails doesn't count as closed: dispatch-test.sh tests that
# (last-task-close-fails), as FLEET_ACT_FAIL here already fails #141's lock in the same round.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fx="$here/fixtures"
expected="$fx/expected.txt"

[[ $# == 0 ]] || { echo "usage: router-test.sh (no options; edit expected.txt by hand)" >&2; exit 2; }

export FLEET_FIXTURES="$fx" FLEET_NOW=1794916800 FLEET_OWNER=fleet-owner FLEET_MAX_JOBS=25 FLEET_MAX_STARTS=6
unset GITHUB_OUTPUT FLEET_EVENT_LABEL FLEET_EVENT_ISSUE FLEET_STOP_ALL FLEET_ACT_FAIL

run() {
  echo "\$ $*"
  # Failing commands are part of what's tested, so record the exit code instead of stopping.
  local code=0
  "$@" 2>&1 || code=$?
  echo "[exit $code]"
  echo
}

# usage <execution file>
usage() {
  run env EXECUTION_FILE="${1:+$fx/$1}" bash "$here/task.sh" usage 104
}

# outcome [NAME=value ...] <issue> <task result> <checkout ran> <agent> <paused> <retry_after>
#   <minutes since start>. Leading NAME=value pairs (SEAT, FLEET_ACT_FAIL) go last into env.
outcome() {
  local extra=()
  while [[ $1 == *=* ]]; do
    extra+=("$1")
    shift
  done
  run env TASK_RESULT="$2" CHECKOUT_RAN="$3" AGENT_OUTCOME="$4" PAUSED="$5" RETRY_AFTER="$6" \
    STARTED="${7:+$((FLEET_NOW - ${7:-0} * 60))}" AGENT_TIMEOUT_MINUTES=55 RUN_ID=777 SEAT=b \
    ${extra[@]+"${extra[@]}"} bash "$here/task.sh" outcome "$1"
}

# waits <issue> <run id> ...: wait_for_runs (lib.sh) on these dispatched runs. runs.json is the
# run list, and run-<id>.json the run read by its id.
waits() {
  local pending="" code=0
  echo "\$ wait_for_runs $*"
  while (($# > 0)); do
    pending+="$1 $2"$'\n'
    shift 2
  done
  bash -c 'source "$1"; fleet_init; wait_for_runs "$2"; echo "missing=$WAIT_MISSING"' _ "$here/lib.sh" "$pending" 2>&1 || code=$?
  echo "[exit $code]"
  echo
}

actual=$(
  run env "FLEET_ACT_FAIL=gh api -X PUT repos/fixture/repo/issues/141/lock*" bash "$here/router.sh"
  run env FLEET_EVENT_LABEL=fleet:stop FLEET_EVENT_ISSUE=101 bash "$here/router.sh"
  run env FLEET_EVENT_LABEL=bug FLEET_EVENT_ISSUE=101 bash "$here/router.sh"
  run env FLEET_STOP_ALL=true bash "$here/router.sh"
  run env FLEET_BUDGET_FLOOR=201 bash "$here/router.sh"
  run env FLEET_BUDGET_FLOOR=201 FLEET_EVENT_LABEL=fleet:stop FLEET_EVENT_ISSUE=101 bash "$here/router.sh"
  run env FLEET_BUDGET_FLOOR=abc bash "$here/router.sh"
  run env FLEET_BUDGET_FLOOR=-5 FLEET_EVENT_LABEL=fleet:stop FLEET_EVENT_ISSUE=101 bash "$here/router.sh"
  run env FLEET_FIXTURES="$fx/graphql-low" bash "$here/router.sh"
  run bash "$here/task.sh" check 104
  run bash "$here/task.sh" check 105
  run bash "$here/task.sh" check 116
  run bash "$here/task.sh" check 124
  run bash "$here/task.sh" base 104
  run bash "$here/task.sh" base 117
  run env BASE=fleet/demo bash "$here/task.sh" pr-state 107
  usage exec-usage-limit.json
  usage exec-limit-text-only.json
  usage exec-error.json
  usage exec-overage.json
  usage exec-overage-last.json
  usage exec-bad.json
  usage ""
  outcome 107 success true success false "" 60
  outcome 117 success true failure false "" 20
  outcome 115 success true success false "" 60
  outcome 121 success true failure true 2027-01-01T00:00:00Z 20
  outcome 121 success true failure true 2026-13-45T99:99:99Z 20
  outcome 121 success true failure true 2026-11-17T15:00:00Z 20
  outcome 120 failure "" "" "" "" ""
  outcome 120 skipped "" "" "" "" ""
  outcome 120 cancelled true cancelled false "" 30
  outcome 120 success false "" "" "" 1
  outcome 120 success true failure false "" 55
  outcome 105 cancelled true cancelled false "" 30
  outcome 125 success true success false "" 60
  outcome "FLEET_ACT_FAIL=gh issue comment 125 *" 125 success true success false "" 60
  outcome "FLEET_ACT_FAIL=gh api -X PUT repos/fixture/repo/issues/125/lock*" 125 success true success false "" 60
  outcome "FLEET_ACT_FAIL=gh api -X PUT repos/fixture/repo/issues/226/lock*" 126 success true success false "" 60
  outcome 142 success true success false "" 60
  outcome 104 bogus yes ::error::x ::warning::y "" 20
  outcome SEAT=A 104 success true success false "" 20
  waits 101 9001 150 9150 151 9151 152 9152
  run env FLEET_FIXTURES="$fx/after-run" FLEET_AFTER_RUN=9160 bash "$here/router.sh"
  run env FLEET_FIXTURES="$fx/after-run" FLEET_AFTER_RUN=9162 bash "$here/router.sh"
  run env FLEET_FIXTURES="$fx/after-run" FLEET_AFTER_RUN=9163 bash "$here/router.sh"
  run env FLEET_FIXTURES="$fx/after-run" FLEET_AFTER_RUN=91x bash "$here/router.sh"
)
# Paths in the output depend on where the repo is checked out. Reasons are dropped (see above).
actual=${actual//$here/.github\/fleet}
actual=$(sed -E 's/^(#[0-9]+ [a-z-]+( pr=[a-z-]+)?): .*/\1/' <<<"$actual")

if diff -u "$expected" <(printf '%s\n' "$actual"); then
  echo "router-test: all decisions match expected.txt"
else
  echo "router-test: decisions differ from expected.txt (see the diff above)" >&2
  exit 1
fi
