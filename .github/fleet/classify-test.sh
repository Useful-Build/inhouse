#!/usr/bin/env bash
# Tests classify (lib.sh), the outcome job's verdict on a task run, against a table written by hand
# from the rules, and the step timeout below. No network, no fixtures. Reads fleet.yml only to check
# its timeout values.
#
# Columns: task job result | checkout ran | agent step | paused claim | timed out | PR state |
# fleet:stop on the issue | outcome. "-" stands for an empty value (a task job that died without
# outputs reports nothing).
# Rules: skipped means nothing started. A cancelled job is cancelled when the task has fleet:stop,
# and progress (a start) otherwise: a manual cancel or GitHub's own job timeout. No checkout: a
# clean refusal is no start, a job that died there is failed. Then a PR that is merged, queued or
# set to auto-merge (checks not failed) is done; a usage limit claim on an agent that didn't
# succeed is paused; an agent that succeeded, or failed at its step timeout, made progress;
# anything else failed.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=SCRIPTDIR/lib.sh
source "$here/lib.sh"

table='
skipped   -     -         -     -     none        false none
skipped   -     -         -     -     merged      true  none
cancelled true  cancelled false false draft       true  cancelled
cancelled -     -         -     -     none        true  cancelled
cancelled true  success   false false automerge   true  cancelled
cancelled true  cancelled false false draft       false progress
cancelled -     -         -     -     none        false progress
cancelled true  failure   true  false none        false progress
success   false -         -     -     none        false none
success   false -         -     -     merged      false none
failure   false -         -     -     none        false failed
failure   -     -         -     -     none        false failed
failure   -     -         -     -     automerge   false failed
failure   false -         -     -     none        true  failed
success   true  success   false false merged      false done
success   true  failure   false false queued      false done
success   true  failure   true  false automerge   false done
success   true  success   false false failing     false progress
success   true  success   false false conflicting false progress
success   true  failure   false false conflicting false failed
success   true  success   false false ready       false progress
success   true  success   false false draft       false progress
success   true  success   false false none        false progress
success   true  failure   true  false none        false paused
success   true  failure   true  false failing     false paused
success   true  success   true  false draft       false progress
success   true  failure   false true  draft       false progress
success   true  failure   false false draft       false failed
success   true  failure   false false failing     false failed
success   true  -         -     -     none        false failed
failure   true  success   false false draft       false progress
failure   true  failure   false false none        false failed
failure   true  -         -     -     none        false failed
failure   true  failure   true  false none        false paused
success   true  invalid   invalid false none      false failed
'

v() { if [[ $1 == - ]]; then echo ""; else echo "$1"; fi; }

fails=0 count=0
while read -r result checkout agent paused timed state stopped want; do
  [[ -n $result ]] || continue
  got=$(classify "$(v "$result")" "$(v "$checkout")" "$(v "$agent")" "$(v "$paused")" "$(v "$timed")" "$state" "$stopped")
  count=$((count + 1))
  if [[ $got != "$want" ]]; then
    echo "FAIL: $result $checkout $agent $paused $timed $state $stopped: want $want, got $got"
    fails=$((fails + 1))
  fi
done <<<"$table"

# The step timeout. The agent step stops at 55 minutes (its GitHub access ends after an hour), and
# the outcome job gets the same number as AGENT_TIMEOUT_MINUTES. A run counts as cut off at its
# timeout when at least that many minutes passed since the task job started (ran_to_timeout in
# lib.sh), and a failed agent step that was cut off made progress.
# Columns: minutes since the job started ("-" for no start time, "x" for one that isn't a number) |
# timeout minutes | agent step | outcome. Task job success, checkout ran, no pause claim, draft PR,
# no fleet:stop.
timeouts='
55 55 failure progress
56 55 failure progress
330 55 failure progress
54 55 failure failed
0 55 failure failed
- 55 failure failed
x 55 failure failed
55 55 success progress
54 55 success progress
'
NOW=1794916800
while read -r minutes limit agent want; do
  [[ -n $minutes ]] || continue
  case $minutes in
    -) started="" ;;
    x) started="12:00" ;;
    *) started=$((NOW - minutes * 60)) ;;
  esac
  timed=false
  if ran_to_timeout "$started" "$limit"; then timed=true; fi
  got=$(classify success true "$agent" false "$timed" draft false)
  count=$((count + 1))
  if [[ $got != "$want" ]]; then
    echo "FAIL: started $minutes minutes ago, timeout $limit, agent $agent: want $want, got $got"
    fails=$((fails + 1))
  fi
done <<<"$timeouts"

# The table above is for 55: the workflow must use that number in all three places, the agent
# step's timeout, the outcome job's AGENT_TIMEOUT_MINUTES and the stop time the agent is told.
wf="$here/../workflows/fleet.yml"
step=$(awk '/^      - name: Agent$/ { on = 1 } on && /timeout-minutes:/ { print $2; exit }' "$wf")
outcome=$(awk -F'"' '/AGENT_TIMEOUT_MINUTES:/ { print $2; exit }' "$wf")
told=$(awk '/^      - name: Stop time$/ { on = 1 }
  on && match($0, /now \+ [0-9]+ \* 60/) { print substr($0, RSTART + 6, RLENGTH - 11); exit }' "$wf")
count=$((count + 1))
if [[ $step != 55 || $outcome != 55 || $told != 55 ]]; then
  echo "FAIL: fleet.yml has the agent step's timeout-minutes '$step', AGENT_TIMEOUT_MINUTES '$outcome' and the stop time now + '$told' minutes, want 55, 55 and 55"
  fails=$((fails + 1))
fi

if ((fails > 0)); then
  echo "classify-test: $fails of $count cases wrong" >&2
  exit 1
fi
echo "classify-test: all $count cases match"
