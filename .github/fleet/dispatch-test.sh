#!/usr/bin/env bash
# Runs router.sh on its live path (no FLEET_FIXTURES, no dry run) against a stub gh and a stub
# sleep put first on PATH, and checks what it sends and how it handles the answers. Needs bash and
# jq, no network, no GitHub token.
#
#   dispatch-test.sh   run every case, exit 1 on the first difference
#
# The expected results below are written by hand from the rules, never copied from the output:
# - The dispatch sends return_run_details as a JSON boolean (-F). Like GitHub, the stub answers
#   200 with the run id only when it's there, and 204 with no body otherwise.
# - A dispatch with no numeric run id is an error naming the task, and the round ends red.
# - A failed dispatch is counted, the loop carries on, the runs already started are still waited
#   for, and failed_tasks and final_prs are still written before the round ends red.
# - A run that isn't in the run list after 13 checks 5 seconds apart, and hasn't finished, is an
#   error naming the task, and the round ends red: 13 reads, 12 sleeps.
# - A run that has already finished ends its wait at once.
# - A task that got fleet:stop after the round read the issues isn't started.
# - The active runs are read with one REST request per status (queued, in_progress, waiting,
#   pending, requested), every page of each.
# - A fleet:stop event whose run list fails ends red with an error naming the task, never as
#   "no active run". A failed cancel, on that path or in stop all, ends the round red.
# - A run list as big as live runs make it (12 runs of 13 KB, over the 128 KB one Linux argument
#   may hold) is read whole: a stop cancels the runs in it and a round counts them.
# - A run list that fails while waiting is a warning naming the task, then the run counts as
#   missing, and the outputs are still written.
# - Each round prints both budgets left, REST and GraphQL, at its start and its end. A figure that
#   can't be read (missing, or not a whole number) is a warning, and the round goes on as if it
#   were above the floor.
# - Below FLEET_BUDGET_FLOOR (200 unless set) in either budget, 0 left included, a round starts
#   nothing, opens no final PR and is green. At or above it, the round runs as usual. A floor of 0
#   turns this off. Stop all runs whatever the budget, and whatever the floor's value; a floor
#   that isn't digits only, 0 or 1 to 9999999999 with no leading zero (08, +5, 5.0 and 11 digits
#   are refused), fails any other round red, after the budget read and before any other. A figure
#   that can't be read doesn't hold a round back, and doesn't stop the other figure from doing so.
# - A final PR read that fails (the open PRs into main, the closed ones, or an issue whose body
#   can't be read) fails that branch's check red, and no final PR opens. It never reads as "a PR is
#   already open", "no closed PR has this head" or "no task names it".
# - task.sh pr-state whose PR read fails fails the step and writes no pr_state.
# - The round that closes the last task of a branch opens its final PR, though GitHub's issue list
#   still shows that issue open (the stub answers every read of the open issues the same, as the
#   list did live). A close that fails leaves the issue open, and no final PR opens.
# - fleet.yml's merged-round job, cut out of the file: a plain round dispatched on main, red
#   without a run id, and its YAML limits (see that case).
# Seats: no markers, so the seat is "abc"[issue number mod 3].
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
[[ $# == 0 ]] || { echo "usage: dispatch-test.sh (no options)" >&2; exit 2; }

mkdir "$tmp/bin"
cat >"$tmp/bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo "sleep $*" >>"$STUB/calls.log"
EOF
cat >"$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Stub gh. Answers from the files in $STUB and logs every call to $STUB/calls.log.
set -euo pipefail
d=$STUB R=fixture/repo
echo "$*" >>"$d/calls.log"
or_default() { if [[ -f $1 ]]; then cat "$1"; else echo "$2"; fi; }
# budget_json <REST left> <GraphQL left>: a rate_limit answer, both resetting at 12:20 UTC.
budget_json() {
  echo "{\"resources\": {\"core\": {\"limit\": 1000, \"remaining\": $1, \"reset\": 1794918000},"
  echo " \"graphql\": {\"limit\": 1000, \"remaining\": $2, \"reset\": 1794918000}}}"
}
unexpected() { echo "stub gh: unexpected call: $*" >&2; exit 97; }
case "$1 ${2:-}" in
  "issue edit" | "issue comment") exit 0 ;;
  # close-fail: closing an issue fails.
  "issue close") if [[ -f $d/close-fail ]]; then echo "stub: HTTP 502" >&2; exit 1; fi; exit 0 ;;
  "pr create") echo "https://github.com/$R/pull/300"; exit 0 ;;
  "api "*) shift ;;
  *) unexpected "$@" ;;
esac
case "$*" in
  rate_limit)
    # rate-limit-fail: the read fails. rate_limit.json: the answer, else 900 of 1000 left in both.
    if [[ -f $d/rate-limit-fail ]]; then echo "stub: HTTP 500" >&2; exit 1; fi
    or_default "$d/rate_limit.json" "$(budget_json 900 900)"
    ;;
  "--paginate --slurp repos/$R/actions/workflows/fleet.yml/runs?status="*"&exclude_pull_requests=true&per_page=100")
    # One read of the active runs asks for each status in turn, queued first. Each line of
    # $STUB/runs is "id|title|status|n": the run is listed from the n-th read on. page-size: runs
    # per page (100 unless set), and --slurp gives the pages as one array, as gh does.
    # list-fail-from: the n-th read and every one after it fail. pad-bytes: each run carries that
    # many bytes more, as a live run object is about 13 KB (repository, head_commit and the rest).
    status=${3#*status=}
    status=${status%%&*}
    if [[ $status == queued ]]; then echo $(($(or_default "$d/list-count" 0) + 1)) >"$d/list-count"; fi
    c=$(cat "$d/list-count")
    if [[ -f $d/list-fail-from ]] && ((c >= $(cat "$d/list-fail-from"))); then echo "stub: HTTP 502" >&2; exit 1; fi
    or_default "$d/runs" "" | jq -Rn --argjson pad "$(or_default "$d/pad-bytes" 0)" --arg s "$status" --argjson c "$c" --argjson p "$(or_default "$d/page-size" 100)" '
      [inputs | select(length > 0)
      | split("|") | select(.[2] == $s and (.[3] | tonumber) <= $c)
      | {id: (.[0] | tonumber), display_title: .[1], status: .[2]}
      | if $pad > 0 then .pad = ("x" * $pad) else . end]
      | length as $n
      | [range(0; ([$n, 1] | max); $p) as $i | {total_count: $n, workflow_runs: .[$i:$i + $p]}]'
    ;;
  "--paginate --slurp repos/$R/issues?state=open&labels=fleet&per_page=100")
    # issues.json: the answer to every read, unless issues-after.json is there: then that is the
    # answer from the second read on (the read again for the final PR).
    echo $(($(or_default "$d/open-count" 0) + 1)) >"$d/open-count"
    f=$d/issues.json
    if [[ -f $d/issues-after.json ]] && (($(cat "$d/open-count") >= 2)); then f=$d/issues-after.json; fi
    printf '[%s]\n' "$(cat "$f")"
    ;;
  "--paginate --slurp repos/$R/issues?state=closed&labels=fleet&per_page=100") printf '[%s]\n' "$(or_default "$d/closed.json" '[]')" ;;
  "--paginate --slurp repos/$R/git/matching-refs/heads/fleet/?per_page=100") printf '[%s]\n' "$(or_default "$d/branches.json" '[]')" ;;
  "--paginate --slurp repos/$R/pulls?state=open&base=main&head="*)
    # prs-open-fail: the read of the open PRs into main fails.
    if [[ -f $d/prs-open-fail ]]; then echo "stub: HTTP 502" >&2; exit 1; fi
    echo '[[]]'
    ;;
  "--paginate --slurp repos/$R/pulls?state=closed&base=main&head="*)
    # prs-closed-fail: the read of the closed PRs into main fails.
    if [[ -f $d/prs-closed-fail ]]; then echo "stub: HTTP 502" >&2; exit 1; fi
    echo '[[]]'
    ;;
  "--paginate --slurp repos/$R/pulls?"*) echo '[[]]' ;;
  "graphql "*)
    # The task PR lookup. graphql-fail: it fails. pulls-<issue>.json, else pulls.json: the PR
    # nodes, else none.
    if [[ -f $d/graphql-fail ]]; then echo "stub: HTTP 502" >&2; exit 1; fi
    p=$d/pulls.json
    for a in "$@"; do
      if [[ $a == head=task/* && -f $d/pulls-${a#head=task/}.json ]]; then p=$d/pulls-${a#head=task/}.json; fi
    done
    printf '{"data": {"repository": {"pullRequests": {"nodes": %s}}}}\n' "$(or_default "$p" '[]')"
    ;;
  "--paginate --slurp repos/$R/issues/"*"/dependencies/blocked_by?per_page=100") echo '[[]]' ;;
  "--paginate --slurp repos/$R/issues/"*"/comments?per_page=100")
    n=${3#repos/"$R"/issues/}
    printf '[%s]\n' "$(or_default "$d/comments-${n%%/*}.json" '[]')"
    ;;
  "-X PUT repos/$R/issues/"*"/lock --silent" | "-X DELETE repos/$R/issues/"*"/lock --silent") ;;
  "-X POST repos/$R/actions/runs/"*"/cancel --silent")
    # cancel-fail: every cancel fails.
    if [[ -f $d/cancel-fail ]]; then echo "stub: HTTP 500" >&2; exit 1; fi
    ;;
  "-X POST repos/$R/actions/workflows/ci.yml/dispatches -f ref="*" --silent") ;;
  "-X POST repos/$R/actions/workflows/fleet.yml/dispatches "*)
    # dispatch-<issue>: the answer, or FAIL. dispatch- (no issue) is a plain round's. --jq is
    # applied as gh does, and like gh it prints nothing for an empty body.
    n="" details=false prev="" filter=""
    for a in "$@"; do
      if [[ $a == "inputs[issue]="* ]]; then n=${a#"inputs[issue]="}; fi
      if [[ $prev == -F && $a == return_run_details=true ]]; then details=true; fi
      if [[ $prev == --jq ]]; then filter=$a; fi
      prev=$a
    done
    answer=$(cat "$d/dispatch-$n")
    if [[ $answer == FAIL ]]; then echo "stub: HTTP 422" >&2; exit 1; fi
    # 204 No Content unless the run's details were asked for.
    if [[ $details == true && -n $filter && -n $answer ]]; then
      jq -r "$filter" <<<"$answer"
    elif [[ $details == true ]]; then
      printf '%s' "$answer"
    fi
    ;;
  "repos/$R/actions/runs/"*" --jq .status")
    id=${1#repos/"$R"/actions/runs/}
    [[ -f $d/run-$id.status ]] || { echo "stub: HTTP 404" >&2; exit 1; }
    cat "$d/run-$id.status"
    ;;
  "repos/$R/compare/main..."*" --jq .ahead_by") cat "$d/ahead" ;;
  "repos/$R/issues/"*)
    n=${1#repos/"$R"/issues/}
    if [[ -f $d/issue-$n.json ]]; then cat "$d/issue-$n.json"; else jq -e --argjson n "$n" '.[] | select(.number == $n)' "$d/issues.json"; fi
    ;;
  *) unexpected api "$@" ;;
esac
EOF
chmod +x "$tmp/bin/gh" "$tmp/bin/sleep"
# Linux refuses to start a program with any one argument of 131072 bytes or more (MAX_ARG_STRLEN,
# "Argument list too long", exit 126). macOS doesn't, so this jq does the same on a Mac. On Linux
# the kernel refuses first, so it changes nothing there.
REAL_JQ=$(command -v jq)
export REAL_JQ
cat >"$tmp/bin/jq" <<'EOF'
#!/usr/bin/env bash
export LC_ALL=C
for a in "$@"; do
  if ((${#a} >= 131072)); then echo "jq: Argument list too long (${#a} bytes)" >&2; exit 126; fi
done
exec "$REAL_JQ" "$@"
EOF
chmod +x "$tmp/bin/jq"

# issue <number> [extra label]: an open, locked fleet issue by the owner, with no Base line.
issue() {
  jq -nc --argjson n "$1" --arg l "${2:-}" '{number: $n, state: "open", locked: true,
    user: {login: "fleet-owner"}, created_at: "2026-11-17T10:00:00Z", body: "brief",
    labels: ([{name: "fleet"}] + (if $l == "" then [] else [{name: $l}] end))}'
}
ok() { printf '{"workflow_run_id":%s,"run_url":"https://api.github.com/repos/fixture/repo/actions/runs/%s","html_url":"https://github.com/fixture/repo/actions/runs/%s"}' "$1" "$1" "$1"; }
# A branch fleet/x that is ready for its final PR: ahead of main, named by a closed task only.
final_ready() {
  echo '[{"ref": "refs/heads/fleet/x", "object": {"sha": "1111111111111111111111111111111111111111"}}]' >"$STUB/branches.json"
  echo 2 >"$STUB/ahead"
  echo '[{"number": 200, "state": "closed", "body": "Base: fleet/x", "labels": [{"name": "fleet"}]}]' >"$STUB/closed.json"
}

fails=0 name="" out="" code=0
# scenario <name>: a fresh stub directory.
scenario() {
  name=$1
  export STUB="$tmp/$name"
  mkdir "$STUB"
  : >"$STUB/calls.log"
}
# route [NAME=value ...]: run the router, with any extra env last.
route() {
  code=0
  out=$(env -u FLEET_FIXTURES -u FLEET_EVENT_LABEL -u FLEET_EVENT_ISSUE -u FLEET_STOP_ALL -u FLEET_AFTER_RUN \
    -u FLEET_BUDGET_FLOOR PATH="$tmp/bin:$PATH" FLEET_REPO=fixture/repo FLEET_OWNER=fleet-owner \
    FLEET_NOW=1794916800 GITHUB_OUTPUT="$STUB/output" "$@" bash "$here/router.sh" 2>&1) || code=$?
}
# task_step <subcommand> <issue> [NAME=value ...]: run task.sh on its live path, any extra env last.
task_step() {
  local sub=$1 n=$2
  shift 2
  code=0
  out=$(env -u FLEET_FIXTURES PATH="$tmp/bin:$PATH" FLEET_REPO=fixture/repo FLEET_OWNER=fleet-owner \
    FLEET_NOW=1794916800 GITHUB_OUTPUT="$STUB/output" "$@" bash "$here/task.sh" "$sub" "$n" 2>&1) || code=$?
}
fail() {
  echo "dispatch-test: $name: $*" >&2
  fails=$((fails + 1))
}
want_exit() { [[ $code == "$1" ]] || fail "exit $code, want $1"; }
want_out() { grep -qxF -- "$1" <<<"$out" || fail "no output line: $1"; }
want_call() { grep -qxF -- "$1" "$STUB/calls.log" || fail "no call: gh $1"; }
want_no_call() { if grep -qF -- "$1" "$STUB/calls.log"; then fail "unwanted call: $1"; fi; }
want_sleeps() {
  local n
  n=$(grep -c '^sleep 5$' "$STUB/calls.log" || true)
  [[ $n == "$1" ]] || fail "$n sleeps, want $1"
}
want_output() { grep -qxF -- "$1" "$STUB/output" 2>/dev/null || fail "no step output: $1"; }
budget_json() {
  echo "{\"resources\": {\"core\": {\"limit\": 1000, \"remaining\": $1, \"reset\": 1794918000},"
  echo " \"graphql\": {\"limit\": 1000, \"remaining\": $2, \"reset\": 1794918000}}}"
}
held="This round starts, closes, labels and cancels nothing and opens no final PR, to leave room for the outcome jobs' markers."
dispatch_call() { echo "api -X POST repos/fixture/repo/actions/workflows/fleet.yml/dispatches -f ref=main -F return_run_details=true -f inputs[issue]=$1 -f inputs[seat]=$2"; }
done_case() {
  if ((fails > 0)); then
    printf '%s\n' "--- output of $name:" "$out" "--- calls:" >&2
    cat "$STUB/calls.log" >&2
    exit 1
  fi
  echo "ok: $name"
}

# The request carries return_run_details, the answer has the id, and the run shows on the second
# poll: one sleep.
scenario id
issue 201 | jq -s . >"$STUB/issues.json"
ok 5001 >"$STUB/dispatch-201"
echo "5001|task #201|queued|3" >"$STUB/runs"
echo queued >"$STUB/run-5001.status"
route
want_call "$(dispatch_call 201 a)"
want_out "#201 started run 5001"
want_out "#201 run 5001 is in the run list"
# One request per active status, each the REST list itself, not gh run list.
for s in queued in_progress waiting pending requested; do
  want_call "api --paginate --slurp repos/fixture/repo/actions/workflows/fleet.yml/runs?status=$s&exclude_pull_requests=true&per_page=100"
done
want_sleeps 1
want_call "api rate_limit"
want_out "fleet budget: REST 900/1000 resets 12:20 UTC, GraphQL 900/1000 resets 12:20 UTC (router start)"
want_out "fleet budget: REST 900/1000 resets 12:20 UTC, GraphQL 900/1000 resets 12:20 UTC (router end)"
want_exit 0
done_case

# 204 with no body: an error naming the task, no wait, red.
scenario no-id
issue 202 | jq -s . >"$STUB/issues.json"
: >"$STUB/dispatch-202"
route
want_call "$(dispatch_call 202 b)"
want_out "::error::#202: the dispatch returned no run id, so this round can't wait for its run"
want_sleeps 0
want_out "fleet: 1 changes failed"
want_exit 1
done_case

# Four tasks: 211 starts, 212's dispatch fails, 213 starts, 214 is past its cap. Both started runs
# are waited for, failed_tasks and final_prs are written, and the round is red for 212 alone.
scenario mid-round
{
  issue 211
  issue 212
  issue 213
  issue 214
} | jq -s . >"$STUB/issues.json"
ok 5011 >"$STUB/dispatch-211"
echo FAIL >"$STUB/dispatch-212"
ok 5013 >"$STUB/dispatch-213"
for r in 1 2 3 4 5 6; do
  jq -n --argjson r "$r" '{user: {login: "github-actions[bot]", type: "Bot"},
    created_at: "2026-11-17T0\($r):00:00Z",
    body: "<!-- fleet:attempt run=\($r) seat=a outcome=progress retry_after= -->\nRun \($r)"}'
done | jq -s . >"$STUB/comments-214.json"
printf '%s\n' "5011|task #211|in_progress|2" "5013|task #213|queued|3" >"$STUB/runs"
echo queued >"$STUB/run-5013.status"
final_ready
route
want_call "$(dispatch_call 211 b)"
want_call "$(dispatch_call 212 c)"
want_call "$(dispatch_call 213 a)"
want_no_call "inputs[issue]=214"
want_out "::error::failed: dispatch task #212"
want_call "issue edit 214 -R fixture/repo --add-label fleet:failed"
want_out "#211 run 5011 is in the run list"
want_out "#213 run 5013 is in the run list"
want_sleeps 1
want_output "failed_tasks=214"
want_output "final_prs=https://github.com/fixture/repo/pull/300"
want_out "fleet: 1 changes failed"
want_exit 1
done_case

# The run never shows and hasn't finished: 13 reads, 12 sleeps, an error naming the task, red.
scenario never-listed
issue 221 | jq -s . >"$STUB/issues.json"
ok 5021 >"$STUB/dispatch-221"
echo in_progress >"$STUB/run-5021.status"
route
want_call "$(dispatch_call 221 c)"
want_sleeps 12
want_out "::error::#221: its run 5021 isn't in the run list after 13 checks 5s apart and hasn't finished, so the next round may start task #221 again"
want_out "fleet: 1 changes failed"
want_exit 1
done_case

# The run isn't listed but has already finished: no sleep, green.
scenario finished
issue 231 | jq -s . >"$STUB/issues.json"
ok 5031 >"$STUB/dispatch-231"
echo completed >"$STUB/run-5031.status"
route
want_call "$(dispatch_call 231 a)"
want_out "#231 run 5031 has finished"
want_sleeps 0
want_exit 0
done_case

# fleet:stop arrived after the round read the issue list: no dispatch.
scenario stopped-meanwhile
issue 241 | jq -s . >"$STUB/issues.json"
issue 241 fleet:stop >"$STUB/issue-241.json"
route
want_no_call "dispatches"
want_out "#241 got fleet:stop during this round, not started"
want_exit 0
done_case

# Every run list read after the round's own fails: a warning naming the task each time, then the
# run is missing, the final PR output is still written, red.
scenario list-fails
issue 251 | jq -s . >"$STUB/issues.json"
ok 5051 >"$STUB/dispatch-251"
echo in_progress >"$STUB/run-5051.status"
echo 2 >"$STUB/list-fail-from"
final_ready
route
want_call "$(dispatch_call 251 c)"
want_out "::warning::listing runs failed while waiting for #251, trying again"
want_out "::error::#251: its run 5051 isn't in the run list after 13 checks 5s apart and hasn't finished, so the next round may start task #251 again"
want_sleeps 12
want_output "final_prs=https://github.com/fixture/repo/pull/300"
want_out "fleet: 1 changes failed"
want_exit 1
done_case

# The budget can't be read: a warning at the start and at the end, and the round runs as it does
# above the floor.
scenario budget-unreadable
issue 261 | jq -s . >"$STUB/issues.json"
ok 5061 >"$STUB/dispatch-261"
echo "5061|task #261|queued|2" >"$STUB/runs"
touch "$STUB/rate-limit-fail"
route
want_out "::warning::fleet budget: REST unreadable, GraphQL unreadable (router start)"
want_out "::warning::fleet budget: REST unreadable, GraphQL unreadable (router end)"
want_call "$(dispatch_call 261 a)"
want_out "#261 run 5061 is in the run list"
want_exit 0
done_case

# 199 left, below the default floor of 200: a warning with the numbers, then nothing but the
# budget is read, nothing starts, no final PR, green.
scenario budget-low
issue 271 | jq -s . >"$STUB/issues.json"
ok 5071 >"$STUB/dispatch-271"
final_ready
budget_json 199 900 >"$STUB/rate_limit.json"
route
want_out "::warning::fleet budget: 199 REST requests left, below the floor of 200. $held"
want_no_call "issues?state=open"
want_no_call "dispatches"
want_no_call "pr create"
[[ $(grep -cvxF "api rate_limit" "$STUB/calls.log") == 0 ]] || fail "a call other than the budget read"
want_exit 0
done_case

# The same low budget with a floor set to 150: 199 is above it, so the task starts.
scenario budget-floor-set
issue 281 | jq -s . >"$STUB/issues.json"
ok 5081 >"$STUB/dispatch-281"
echo "5081|task #281|queued|2" >"$STUB/runs"
budget_json 199 900 >"$STUB/rate_limit.json"
route FLEET_BUDGET_FLOOR=150
want_call "$(dispatch_call 281 c)"
want_out "#281 run 5081 is in the run list"
want_exit 0
done_case

# Stop all below the floor: stopping always wins, so the label and the cancel still go out.
scenario budget-low-stop-all
issue 291 | jq -s . >"$STUB/issues.json"
echo "5091|task #291|in_progress|1" >"$STUB/runs"
budget_json 10 900 >"$STUB/rate_limit.json"
route FLEET_STOP_ALL=true
want_call "issue edit 291 -R fixture/repo --add-label fleet:stop"
want_call "api -X POST repos/fixture/repo/actions/runs/5091/cancel --silent"
want_out "stop all: done"
want_exit 0
done_case

# 0 left is below any floor: the round holds back, green.
scenario budget-zero
issue 301 | jq -s . >"$STUB/issues.json"
budget_json 0 900 >"$STUB/rate_limit.json"
route
want_out "::warning::fleet budget: 0 REST requests left, below the floor of 200. $held"
want_no_call "dispatches"
want_exit 0
done_case

# REST above the floor, GraphQL below it: the round holds back on GraphQL alone.
scenario budget-graphql-low
issue 302 | jq -s . >"$STUB/issues.json"
budget_json 900 150 >"$STUB/rate_limit.json"
route
want_out "fleet budget: REST 900/1000 resets 12:20 UTC, GraphQL 150/1000 resets 12:20 UTC (router start)"
want_out "::warning::fleet budget: 150 GraphQL points left, below the floor of 200. $held"
want_no_call "dispatches"
want_exit 0
done_case

# Both below: the warning names both.
scenario budget-both-low
issue 303 | jq -s . >"$STUB/issues.json"
budget_json 20 30 >"$STUB/rate_limit.json"
route
want_out "::warning::fleet budget: 20 REST requests and 30 GraphQL points left, below the floor of 200. $held"
want_no_call "dispatches"
want_exit 0
done_case

# No GraphQL figure: a warning line, and the round goes on, held back by REST alone (900, above).
scenario budget-graphql-unreadable
issue 304 | jq -s . >"$STUB/issues.json"
ok 6004 >"$STUB/dispatch-304"
echo "6004|task #304|queued|2" >"$STUB/runs"
echo '{"resources": {"core": {"limit": 1000, "remaining": 900, "reset": 1794918000}}}' >"$STUB/rate_limit.json"
route
want_out "::warning::fleet budget: REST 900/1000 resets 12:20 UTC, GraphQL unreadable (router start)"
want_call "$(dispatch_call 304 b)"
want_exit 0
done_case

# remaining as the string "5" isn't a number, so it's unreadable, not 5: a warning, the round goes on.
scenario budget-not-a-number
issue 305 | jq -s . >"$STUB/issues.json"
ok 6005 >"$STUB/dispatch-305"
echo "6005|task #305|queued|2" >"$STUB/runs"
echo '{"resources": {"core": {"limit": 1000, "remaining": "5", "reset": 1794918000},
  "graphql": {"limit": 1000, "remaining": 900, "reset": 1794918000}}}' >"$STUB/rate_limit.json"
route
want_out "::warning::fleet budget: REST unreadable, GraphQL 900/1000 resets 12:20 UTC (router start)"
want_call "$(dispatch_call 305 c)"
want_exit 0
done_case

# A floor of 0 turns the guard off: 10 left, and the task still starts.
scenario budget-floor-off
issue 306 | jq -s . >"$STUB/issues.json"
ok 6006 >"$STUB/dispatch-306"
echo "6006|task #306|queued|2" >"$STUB/runs"
budget_json 10 10 >"$STUB/rate_limit.json"
route FLEET_BUDGET_FLOOR=0
want_call "$(dispatch_call 306 a)"
want_exit 0
done_case

# A negative floor: the round fails red before it reads anything but the budget.
scenario budget-floor-negative
issue 307 | jq -s . >"$STUB/issues.json"
route FLEET_BUDGET_FLOOR=-5
want_out "fleet: FLEET_BUDGET_FLOOR must be digits only: 0 (no floor), or 1 to 9999999999 with no leading zero. Only the stop rounds run until it's fixed."
[[ $(grep -cvxF "api rate_limit" "$STUB/calls.log") == 0 ]] || fail "a call other than the budget read"
want_exit 1
done_case

# REST unreadable, GraphQL 150: the figure that can be read still holds the round back, green.
scenario budget-rest-unreadable-graphql-low
issue 309 | jq -s . >"$STUB/issues.json"
echo '{"resources": {"graphql": {"limit": 1000, "remaining": 150, "reset": 1794918000}}}' >"$STUB/rate_limit.json"
route
want_out "::warning::fleet budget: REST unreadable, GraphQL 150/1000 resets 12:20 UTC (router start)"
want_out "::warning::fleet budget: 150 GraphQL points left, below the floor of 200. $held"
want_no_call "dispatches"
[[ $(grep -cvxF "api rate_limit" "$STUB/calls.log") == 0 ]] || fail "a call other than the budget read"
want_exit 0
done_case

# The mirror: GraphQL unreadable, REST 150. REST alone holds the round back, green.
scenario budget-graphql-unreadable-rest-low
issue 309 | jq -s . >"$STUB/issues.json"
echo '{"resources": {"core": {"limit": 1000, "remaining": 150, "reset": 1794918000}}}' >"$STUB/rate_limit.json"
route
want_out "::warning::fleet budget: REST 150/1000 resets 12:20 UTC, GraphQL unreadable (router start)"
want_out "::warning::fleet budget: 150 REST requests left, below the floor of 200. $held"
want_no_call "dispatches"
[[ $(grep -cvxF "api rate_limit" "$STUB/calls.log") == 0 ]] || fail "a call other than the budget read"
want_exit 0
done_case

# Floors that aren't digits only, start with a zero or are too long, numbered in this order:
# 08, 007, +5, " 5", 5.0, 12345678901. Each fails red after the budget read with the message
# that says what is accepted, and reads nothing else.
i=0
for v in 08 007 +5 " 5" 5.0 12345678901; do
  i=$((i + 1))
  scenario "budget-floor-shape-$i"
  issue 310 | jq -s . >"$STUB/issues.json"
  route "FLEET_BUDGET_FLOOR=$v"
  want_out "fleet: FLEET_BUDGET_FLOOR must be digits only: 0 (no floor), or 1 to 9999999999 with no leading zero. Only the stop rounds run until it's fixed."
  [[ $(grep -cvxF "api rate_limit" "$STUB/calls.log") == 0 ]] || fail "a call other than the budget read"
  want_exit 1
  done_case
done

# A floor that is text doesn't stop stop all: the label and the cancel go out, green.
scenario budget-floor-text-stop-all
issue 308 | jq -s . >"$STUB/issues.json"
echo "6008|task #308|in_progress|1" >"$STUB/runs"
route FLEET_BUDGET_FLOOR=abc FLEET_STOP_ALL=true
want_call "issue edit 308 -R fixture/repo --add-label fleet:stop"
want_call "api -X POST repos/fixture/repo/actions/runs/6008/cancel --silent"
want_out "stop all: done"
want_exit 0
done_case

# A fleet:stop event whose run list fails: red, an error naming the task, no cancel, and never
# "no active run".
scenario stop-list-fails
issue 311 fleet:stop | jq -s . >"$STUB/issues.json"
echo 1 >"$STUB/list-fail-from"
route FLEET_EVENT_LABEL=fleet:stop FLEET_EVENT_ISSUE=311
want_out "fleet: #311 stop: listing the active runs failed, so its run wasn't cancelled"
if grep -qF "no active run" <<<"$out"; then fail "printed no active run"; fi
want_no_call "/cancel"
want_exit 1
done_case

# A fleet:stop event whose cancel fails: red.
scenario stop-cancel-fails
issue 312 fleet:stop | jq -s . >"$STUB/issues.json"
echo "6012|task #312|in_progress|1" >"$STUB/runs"
touch "$STUB/cancel-fail"
route FLEET_EVENT_LABEL=fleet:stop FLEET_EVENT_ISSUE=312
want_out "::error::failed: gh api -X POST repos/fixture/repo/actions/runs/6012/cancel --silent"
want_out "fleet: 1 changes failed"
want_exit 1
done_case

# Stop all whose cancel fails: red.
scenario stop-all-cancel-fails
issue 313 | jq -s . >"$STUB/issues.json"
echo "6013|task #313|in_progress|1" >"$STUB/runs"
touch "$STUB/cancel-fail"
route FLEET_STOP_ALL=true
want_out "::error::failed: gh api -X POST repos/fixture/repo/actions/runs/6013/cancel --silent"
want_out "fleet: 1 changes failed"
want_exit 1
done_case

# One run per page. #322's run is on the second page of in_progress runs, so #322 is running and
# isn't started; #321 starts, and its run shows on the third page from the second read of the wait.
scenario paged-runs
{
  issue 321
  issue 322
} | jq -s . >"$STUB/issues.json"
ok 6021 >"$STUB/dispatch-321"
echo 1 >"$STUB/page-size"
printf '%s\n' "6099|task #399|in_progress|1" "6022|task #322|in_progress|1" "6021|task #321|in_progress|3" >"$STUB/runs"
echo in_progress >"$STUB/run-6021.status"
route
want_out "task runs active: 2, cap 16"
want_out "#322 skip-running pr=none: a task #322 run is queued or running"
want_no_call "inputs[issue]=322"
want_call "$(dispatch_call 321 a)"
want_out "#321 run 6021 is in the run list"
want_sleeps 1
want_exit 0
done_case

# The open PRs into main can't be read: fleet/x's check fails red, it never reads as "a PR into
# main is already open", and no final PR opens.
scenario final-open-prs-fail
echo '[]' >"$STUB/issues.json"
final_ready
touch "$STUB/prs-open-fail"
route
want_out "::error::fleet/x final PR: check failed"
if grep -qF "already open" <<<"$out"; then fail "read as a PR already open"; fi
want_no_call "pr create"
want_out "fleet: 1 changes failed"
want_exit 1
done_case

# The closed PRs into main can't be read: the check fails red, and no final PR opens again over
# one the owner may have closed.
scenario final-closed-prs-fail
echo '[]' >"$STUB/issues.json"
final_ready
touch "$STUB/prs-closed-fail"
route
want_out "::error::fleet/x final PR: check failed"
want_no_call "pr create"
want_out "fleet: 1 changes failed"
want_exit 1
done_case

# An open fleet issue whose body isn't text: the round skips it with a warning, and fleet/x's check
# can't tell whether it names the branch, so it fails red and no final PR opens.
scenario final-open-issue-unreadable
issue 351 | jq '[.body = 5]' >"$STUB/issues.json"
final_ready
route
want_out "::warning::#351 skipped this round: reading its state failed"
want_out "::error::fleet/x final PR: check failed"
want_no_call "pr create"
want_out "fleet: 1 changes failed"
want_exit 1
done_case

# The same with a closed fleet issue: no telling whether a closed task names the branch, so red.
scenario final-closed-issue-unreadable
echo '[]' >"$STUB/issues.json"
final_ready
echo '[{"number": 201, "state": "closed", "body": 5, "labels": [{"name": "fleet"}]}]' >"$STUB/closed.json"
route
want_out "::error::fleet/x final PR: check failed"
want_no_call "pr create"
want_out "fleet: 1 changes failed"
want_exit 1
done_case

# task.sh pr-state reads a draft PR into the base: pr_state=draft, green.
scenario pr-state-draft
echo '[{"number": 41, "state": "OPEN", "isDraft": true, "isInMergeQueue": false, "isCrossRepository": false,
  "baseRefName": "fleet/x", "locked": true, "mergeable": "MERGEABLE", "autoMergeRequest": null,
  "commits": {"nodes": [{"commit": {"statusCheckRollup": null}}]}}]' >"$STUB/pulls.json"
task_step pr-state 341 BASE=fleet/x
want_output "pr_state=draft"
want_exit 0
done_case

# Its PR read fails: the step fails and writes no pr_state, so the checkpoint warns.
scenario pr-state-fails
touch "$STUB/graphql-fail"
task_step pr-state 341 BASE=fleet/x
if grep -q "^pr_state=" "$STUB/output" 2>/dev/null; then fail "wrote a pr_state"; fi
want_exit 1
done_case

# The last task of fleet/x, #260, has its PR merged. The round closes it, and the open issues read
# again for the final PR still list it, as GitHub's list did live (run 44256227996). The final PR
# opens, and ci starts on fleet/x, green.
last_task() {
  final_ready
  echo '[]' >"$STUB/closed.json"
  issue 260 | jq -s 'map(.body = "brief\nBase: fleet/x")' >"$STUB/issues.json"
  echo '[{"number": 70, "state": "MERGED", "isDraft": false, "isInMergeQueue": false, "isCrossRepository": false,
    "baseRefName": "fleet/x", "locked": true, "mergeable": "UNKNOWN", "autoMergeRequest": null,
    "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "SUCCESS"}}}]}}]' >"$STUB/pulls.json"
}
scenario last-task-lag
last_task
route
want_out "#260 done pr=merged: PR #70 merged"
want_call "issue close 260 -R fixture/repo"
want_out "fleet/x final PR: ready"
want_call "api -X POST repos/fixture/repo/actions/workflows/ci.yml/dispatches -f ref=fleet/x --silent"
want_output "final_prs=https://github.com/fixture/repo/pull/300"
want_exit 0
done_case

# The same, but the close fails: #260 is still open, so no final PR, and the round is red.
scenario last-task-close-fails
last_task
touch "$STUB/close-fail"
route
want_out "fleet/x final PR: not ready, an open task names it"
want_no_call "pr create"
want_out "fleet: 1 changes failed"
want_exit 1
done_case

# Two branches. The round closes #260, the last task of fleet/x, while #261, a task of fleet/y, has
# a run in progress (fleet/y also has a closed task, #201). Only the issue the round closed counts
# as closed: fleet/x's final PR opens, fleet/y's doesn't.
scenario final-other-branch-running
last_task
echo '[{"ref": "refs/heads/fleet/x", "object": {"sha": "1111111111111111111111111111111111111111"}},
  {"ref": "refs/heads/fleet/y", "object": {"sha": "2222222222222222222222222222222222222222"}}]' >"$STUB/branches.json"
echo '[{"number": 201, "state": "closed", "body": "Base: fleet/y", "labels": [{"name": "fleet"}]}]' >"$STUB/closed.json"
{
  issue 260
  issue 261
} | jq -s 'map(.body = "brief\nBase: fleet/" + (if .number == 260 then "x" else "y" end))' >"$STUB/issues.json"
echo '[]' >"$STUB/pulls-261.json"
echo "5261|task #261|in_progress|1" >"$STUB/runs"
route
want_out "#260 done pr=merged: PR #70 merged"
want_out "#261 skip-running pr=none: a task #261 run is queued or running"
want_call "issue close 260 -R fixture/repo"
want_out "fleet/x final PR: ready"
want_out "fleet/y final PR: not ready, an open task names it"
want_call "api -X POST repos/fixture/repo/actions/workflows/ci.yml/dispatches -f ref=fleet/x --silent"
want_no_call "--head fleet/y"
want_no_call "ref=fleet/y"
want_output "final_prs=https://github.com/fixture/repo/pull/300"
want_exit 0
done_case

# No lag: the round closes #260, and the lists read again already have it closed and not open. It
# counts once, as a closed task naming fleet/x, and the final PR opens, once.
scenario last-task-no-lag
last_task
printf '%s\n' '[{"number": 260, "state": "closed", "body": "brief\nBase: fleet/x", "labels": [{"name": "fleet"}]}]' >"$STUB/closed.json"
echo '[]' >"$STUB/issues-after.json"
route
want_out "#260 done pr=merged: PR #70 merged"
want_call "issue close 260 -R fixture/repo"
want_out "fleet/x final PR: ready"
[[ $(grep -c '^pr create' "$STUB/calls.log") == 1 ]] || fail "want exactly one pr create"
want_output "final_prs=https://github.com/fixture/repo/pull/300"
want_exit 0
done_case

# Live run objects are about 13 KB each. big_runs: 12 in_progress runs 9100 to 9111 of tasks #330
# to #341, padded to 13,000 bytes each, about 157 KB together, over the 128 KB a Linux argument
# may hold. #331's run is 9101.
big_runs() {
  local i
  for i in $(seq 0 11); do echo "$((9100 + i))|task #$((330 + i))|in_progress|1"; done >"$STUB/runs"
  echo 13000 >"$STUB/pad-bytes"
}

# fleet:stop on #331 with 12 runs active: its one run, 9101, is cancelled, green.
scenario big-runs-stop
issue 331 fleet:stop | jq -s . >"$STUB/issues.json"
big_runs
route FLEET_EVENT_LABEL=fleet:stop FLEET_EVENT_ISSUE=331
want_call "api -X POST repos/fixture/repo/actions/runs/9101/cancel --silent"
want_exit 0
done_case

# Stop all with 12 runs active: every one of the 12 is cancelled, green.
scenario big-runs-stop-all
issue 331 | jq -s . >"$STUB/issues.json"
big_runs
route FLEET_STOP_ALL=true
for i in $(seq 0 11); do want_call "api -X POST repos/fixture/repo/actions/runs/$((9100 + i))/cancel --silent"; done
want_exit 0
done_case

# A round with 12 runs active: 12 of 16 slots taken, #331 is running so it isn't started, and no
# other issue is open, so nothing is dispatched, green.
scenario big-runs-round
issue 331 | jq -s . >"$STUB/issues.json"
big_runs
route
want_out "task runs active: 12, cap 16"
want_out "#331 skip-running pr=none: a task #331 run is queued or running"
want_no_call "fleet.yml/dispatches"
want_exit 0
done_case

# The merged-round job in fleet.yml: a PR merged into a fleet branch starts a round on main. Its
# shell is cut out of fleet.yml and run against the stub gh, and its YAML is checked for what can't
# run here. Rules: the dispatch is fleet.yml with ref main and return_run_details as a JSON boolean,
# and no inputs (a plain round, not a task run and not after_run); a 204, or an answer without a
# numeric id, is an error and red. The job checks out nothing and uses no action (the file is the
# fleet branch's copy), has actions: write only, runs only for a merged PR from this repo (its if
# exactly, no ||), and the trigger is pull_request closed on fleet/**. It has no environment and no
# secret, its env is exactly the token and github.repository, and its concurrency is the one group
# fleet-merged-round with cancel-in-progress false. The router job never runs on that event, the
# task jobs (bad-seat, task, outcome, next-round) only on workflow_dispatch, and the run name for
# it carries the PR number and nothing else from the PR.
wf="$here/../workflows/fleet.yml"
job=$(awk '/^  merged-round:$/ { on = 1; print; next } on && /^  [a-z]/ { exit } on' "$wf")
script=$(awk '/^        run: \|$/ { on = 1; next } on && /^          / { print substr($0, 11); next }
  on && /^ *$/ { print ""; next } on { exit }' <<<"$job")
# job_if <job>: that job's if in fleet.yml, its lines joined with one space.
job_if() {
  awk -v j="  $1:" '$0 == j { on = 1; next } on && /^  [a-z]/ { exit }
    on && /^    if:/ { sub(/^    if: *(>-)? */, ""); s = $0; c = 1; next }
    c && /^      / { sub(/^ +/, ""); s = (s == "" ? $0 : s " " $0); next } c { exit }
    END { print s }' "$wf"
}
# merged_round: run the job's shell as its step does, with the stub gh first on PATH.
merged_round() {
  code=0
  out=$(env PATH="$tmp/bin:$PATH" GH_TOKEN=stub REPO=fixture/repo bash -c "$script" 2>&1) || code=$?
}

scenario merged-round
ok 6001 >"$STUB/dispatch-"
merged_round
want_call "api -X POST repos/fixture/repo/actions/workflows/fleet.yml/dispatches -f ref=main -F return_run_details=true --jq .workflow_run_id // empty"
want_no_call "inputs["
want_out "started router run 6001"
want_exit 0
done_case

scenario merged-round-no-id
: >"$STUB/dispatch-"
merged_round
want_out "::error::the dispatch was accepted but returned no run id, so the round it started can't be found"
want_exit 1
done_case

scenario merged-round-yaml
[[ -n $script ]] || fail "no run script in the merged-round job"
perms=$(awk '/^    permissions:/ { on = 1; next } on && /^      / { print; next } on { exit }' <<<"$job")
[[ $perms == "      actions: write" ]] || fail "merged-round permissions are '$perms', want actions: write only"
if grep -qE '^ +(- )?uses:' <<<"$job"; then fail "merged-round uses an action"; fi
grep -qF "github.event_name == 'pull_request' && github.event.pull_request.merged &&" <<<"$job" ||
  fail "merged-round doesn't require a merged PR"
grep -qF "github.event.pull_request.head.repo.full_name == github.repository" <<<"$job" ||
  fail "merged-round doesn't require a PR from this repo"
trigger=$(awk '/^  pull_request:$/ { on = 1; next } on && /^    / { print; next } on && !/^ *#/ { exit }' "$wf")
[[ $trigger == $'    types: [closed]\n    branches: ["fleet/**"]' ]] ||
  fail "the pull_request trigger is '$trigger', want types [closed] and branches fleet/**"
router_if=$(awk '/^  router:$/ { on = 1; next } on && /^    if:/ { getline; print; exit }' "$wf")
grep -qF "github.event_name != 'pull_request'" <<<"$router_if" || fail "the router job can run on a pull_request event"
# The job's if, exactly: all three conditions, nothing that can widen it (no ||).
want_if="github.event_name == 'pull_request' && github.event.pull_request.merged && github.event.pull_request.head.repo.full_name == github.repository"
[[ $(job_if merged-round) == "$want_if" ]] || fail "merged-round's if is '$(job_if merged-round)', want '$want_if'"
if grep -qF '||' <<<"$(job_if merged-round)"; then fail "merged-round's if has ||"; fi
# One running and one pending, for the whole repo: one group, never cancelled in progress.
conc=$(awk '/^    concurrency:$/ { on = 1; print; next } on && /^      / { print; next } on { exit }' <<<"$job")
[[ $conc == $'    concurrency:\n      group: fleet-merged-round\n      cancel-in-progress: false' ]] ||
  fail "merged-round's concurrency is '$conc', want group fleet-merged-round, cancel-in-progress false"
if grep -qF 'cancel-in-progress: true' <<<"$job"; then fail "merged-round cancels in-progress runs"; fi
# No environment and no secret: the file is the fleet branch's copy.
if grep -qE '^ +environment:' <<<"$job"; then fail "merged-round has an environment"; fi
if grep -qF 'secrets' <<<"$job"; then fail "merged-round reads a secret"; fi
# One env block, exactly the token and this repository (never a name from the PR's head).
[[ $(grep -cE '^ +env:' <<<"$job") == 1 ]] || fail "merged-round has more than one env block"
envb=$(awk '/^        env:$/ { on = 1; next } on && /^          / { print; next } on { exit }' <<<"$job")
[[ $envb == $'          GH_TOKEN: ${{ github.token }}\n          REPO: ${{ github.repository }}' ]] ||
  fail "merged-round's env is '$envb', want GH_TOKEN from github.token and REPO from github.repository only"
# The task jobs run only on a dispatch, never on this event.
for j in bad-seat task outcome next-round; do
  grep -qF "github.event_name == 'workflow_dispatch' &&" <<<"$(job_if "$j")" ||
    fail "$j's if doesn't require github.event_name == 'workflow_dispatch'"
  if grep -qF '||' <<<"$(job_if "$j")"; then fail "$j's if has ||"; fi
done
# The run name for this event carries the PR number and nothing else from the PR: the router finds
# task runs by their exact name, and a title is text anyone opening a PR can choose.
want_rn="run-name: \"\${{ inputs.stop_all && 'fleet stop all' || (inputs.issue && format('task #{0}', inputs.issue) || (github.event_name == 'pull_request' && format('fleet PR #{0} closed', github.event.pull_request.number) || 'fleet router')) }}\""
[[ $(grep '^run-name:' "$wf") == "$want_rn" ]] || fail "the run-name is '$(grep '^run-name:' "$wf")', want '$want_rn'"
done_case

echo "dispatch-test: all cases match"
