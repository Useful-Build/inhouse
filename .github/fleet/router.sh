#!/usr/bin/env bash
# The fleet router: decides, from real GitHub state, which task issues to start, and starts them.
#
#   router.sh             act: lock and dispatch task runs, close done issues, label capped ones,
#                         open the final PR of a finished fleet/<topic> branch and start its ci
#   router.sh --dry-run   print every decision and the commands it would run, change nothing
#
# Env: FLEET_OWNER (required), FLEET_MAX_JOBS (16), FLEET_MAX_STARTS (6), FLEET_BUDGET_FLOOR (200:
# a round that starts with fewer REST requests or GraphQL points left starts nothing; 0 turns
# this off), FLEET_REPO (from the
# checkout), FLEET_EVENT_LABEL and FLEET_EVENT_ISSUE (the label event that started the run, if
# any), FLEET_STOP_ALL=true (stop every task and exit), FLEET_AFTER_RUN (the id of the task run
# whose next-round job started this round: that run is ending, so it isn't counted as running).
# FLEET_FIXTURES=<dir> reads fixture JSON instead of the API and implies --dry-run. FLEET_NOW
# fixes the clock (epoch seconds). The failure list this answers is FAILURES.md next to this file.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=SCRIPTDIR/lib.sh
source "$here/lib.sh"

DRY_RUN=0
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=1 ;;
    *) die "unknown argument: $arg (usage: router.sh [--dry-run])" ;;
  esac
done
fleet_init

failures=0
# Runs a change for one issue. A failure is logged and counted, and the round carries on.
try_act() {
  if ! act "$@"; then
    echo "::error::failed: $*"
    failures=$((failures + 1))
    return 1
  fi
}

# Cancels every active run of one task.
cancel_task_runs() {
  local n=$1 active=$2 ids id
  ids=$(jq -r --arg t "task #$n" '.[] | select(.displayTitle == $t) | .databaseId' <<<"$active")
  for id in $ids; do
    echo "#$n stop: cancel run $id"
    try_act gh api -X POST "repos/$FLEET_REPO/actions/runs/$id/cancel" --silent || true
  done
  if [[ -z $ids ]]; then echo "#$n stop: no active run"; fi
}

# Stop all: fleet:stop on every open fleet issue, then cancel every task run.
stop_all() {
  local issues active n ids id
  issues=$(api_issues)
  for n in $(jq -r '.[].number' <<<"$issues"); do
    if has_label "$(jq -c --argjson n "$n" '.[] | select(.number == $n)' <<<"$issues")" fleet:stop; then
      echo "#$n stop all: already stopped"
    else
      echo "#$n stop all: add fleet:stop"
      try_act gh issue edit "$n" -R "$FLEET_REPO" --add-label fleet:stop || true
    fi
  done
  active=$(api_active_runs)
  ids=$(jq -r '.[] | select(.displayTitle | test("^task #[0-9]+$")) | "\(.databaseId) \(.displayTitle)"' <<<"$active")
  while read -r id _; do
    [[ -n $id ]] || continue
    echo "stop all: cancel run $id"
    try_act gh api -X POST "repos/$FLEET_REPO/actions/runs/$id/cancel" --silent || true
  done <<<"$ids"
  echo "stop all: done"
}

# Prints how many open or closed issues (JSON on stdin) name branch $1 in their Base line.
count_naming() {
  jq --arg b "$1" '[.[] | select(((.body // "") | split("\n") | map(sub("\r$"; ""))
    | map(capture("^Base: (?<b>fleet/[A-Za-z0-9._-]+)\\s*$").b) | first // "") == $b)] | length'
}

# Checks one fleet/<topic> branch and opens its final PR when it's ready. Runs in a subshell:
# writes "opened", the PR URL and "ci-failed" to files in $tmp for the caller.
final_pr_for() {
  local b=$1 sha=$2 open=$3 closed=$4 ahead naming prs heads merged body url
  # Each read is assigned on its own line, so a failed read stops this branch's check. Inside
  # [[ ]], (( )) or an if, it would read as an empty answer.
  ahead=$(api_ahead_of_main "$b")
  if ((ahead == 0)); then echo "$b final PR: not ahead of main"; return; fi
  naming=$(count_naming "$b" <<<"$open")
  if ((naming > 0)); then echo "$b final PR: not ready, an open task names it"; return; fi
  naming=$(count_naming "$b" <<<"$closed")
  if ((naming == 0)); then echo "$b final PR: not ready, no closed task names it"; return; fi
  prs=$(api_prs_to_main "$b" | jq length)
  if [[ $prs != 0 ]]; then echo "$b final PR: a PR into main is already open"; return; fi
  # The owner closed a final PR at this very commit: don't reopen it until the branch moves on.
  heads=$(api_closed_heads_to_main "$b")
  if jq -e --arg s "$sha" 'index($s) != null' <<<"$heads" >/dev/null; then
    echo "$b final PR: a closed PR into main has this head, not reopened"
    return
  fi
  merged=$(api_merged_into "$b" | jq -r 'map("- #\(.)") | join("\n")')
  body="Every fleet task issue for \`$b\` is closed. Task PRs merged into it:

${merged:-none}"
  echo "$b final PR: ready"
  touch "$tmp/opened"
  if [[ $DRY_RUN == 1 ]]; then
    act gh pr create -R "$FLEET_REPO" --base main --head "$b" --title "$b into main" --body "$body"
  else
    url=$(gh pr create -R "$FLEET_REPO" --base main --head "$b" --title "$b into main" --body "$body")
    [[ $url =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+$ ]] || die "unexpected gh pr create output: $url"
    echo "$b final PR: opened $url"
    echo "$url" >"$tmp/url"
  fi
  # A PR opened with GITHUB_TOKEN gets only a ci run that waits for a person's approval, and main
  # requires ci. A dispatch with GITHUB_TOKEN always creates a run, and its ci check lands on the
  # branch's head commit.
  if ! act gh api -X POST "repos/$FLEET_REPO/actions/workflows/ci.yml/dispatches" -f "ref=$b" --silent; then
    echo "::error::$b final PR: starting ci failed. Run ci on $b by hand."
    touch "$tmp/ci-failed"
  fi
}

# The final PR: a fleet/<topic> branch whose tasks are all finished gets one PR into main.
# Ready when the branch is ahead of main, at least one closed fleet issue names it as Base, no open
# fleet issue names it (stopped and failed ones are open too), no open PR into main exists, and
# no closed, unmerged PR into main has the branch's current head. The issue lists are read fresh
# here, but GitHub's lists can still show an issue as open seconds after this round closed it, so
# the issues in $closed_now (closed by this round) count as closed whatever the lists say: moved
# out of the open list and into the closed one, as the round read them. Sets FINAL_URLS (space
# separated) and FINAL_COUNT.
final_prs() {
  local open closed branches b sha rc ids
  FINAL_URLS="" FINAL_COUNT=0
  branches=$(api_fleet_branches)
  [[ $(jq length <<<"$branches") != 0 ]] || return 0
  open=$(api_issues_after_round)
  closed=$(api_closed_issues)
  if [[ -n $closed_now ]]; then
    # shellcheck disable=SC2086 # numbers only, split on purpose
    ids=$(jq -nc '$ARGS.positional | map(tonumber)' --args $closed_now)
    open=$(jq --argjson ids "$ids" 'map(select(.number as $n | $ids | index($n) | not))' <<<"$open")
    # The closed entries come from $issues, the round's start-of-round read: the same snapshot
    # that decided the close.
    # On stdin, not as an argument: the round's issue list can pass the 128 KB one argument may hold.
    closed=$(printf '%s\n%s\n' "$closed" "$issues" | jq -s --argjson ids "$ids" '
      ([.[0][] | select(.number as $n | $ids | index($n) | not)]
        + [.[1][] | select(.number as $n | $ids | index($n))])')
  fi
  while IFS=$'\x1f' read -r b sha; do
    if [[ ! $b =~ ^fleet/[A-Za-z0-9._-]+$ ]]; then
      warn "a fleet branch name isn't of the form fleet/<topic>, skipped"
      continue
    fi
    if [[ ! $sha =~ ^[0-9a-f]{40}$ ]]; then
      warn "branch $b: head commit unreadable, skipped"
      continue
    fi
    rm -f "$tmp/opened" "$tmp/url" "$tmp/ci-failed"
    # Not inside an if: errexit must stay on in the subshell. One branch's error skips that branch.
    set +e
    # stdin closed: the loop reads the branch list from it, and no gh call may take it.
    (
      set -e
      final_pr_for "$b" "$sha" "$open" "$closed"
    ) </dev/null
    rc=$?
    set -e
    if ((rc != 0)); then
      echo "::error::$b final PR: check failed"
      failures=$((failures + 1))
      continue
    fi
    if [[ -f $tmp/opened ]]; then FINAL_COUNT=$((FINAL_COUNT + 1)); fi
    if [[ -s $tmp/url ]]; then FINAL_URLS="${FINAL_URLS:+$FINAL_URLS }$(cat "$tmp/url")"; fi
    if [[ -f $tmp/ci-failed ]]; then failures=$((failures + 1)); fi
  done < <(jq -r '.[] | "\(.name)\u001f\(.sha)"' <<<"$branches")
}

tmp=$(mktemp -d)
# The budget line at the end prints on every way out, a red round included.
trap 'budget "router end"; rm -rf "$tmp"' EXIT
budget "router start"

if [[ ${FLEET_STOP_ALL:-false} == true ]]; then
  stop_all
  if ((failures > 0)); then die "$failures changes failed"; fi
  exit 0
fi

case ${FLEET_EVENT_LABEL:-} in
  "" | fleet) ;;
  fleet:stop)
    n=${FLEET_EVENT_ISSUE:-}
    is_number "$n" || die "fleet:stop event without an issue number"
    # On its own line: a failed substitution passed as an argument wouldn't stop the round, and an
    # empty list would read as "no active run".
    active=$(api_active_runs) || die "#$n stop: listing the active runs failed, so its run wasn't cancelled"
    cancel_task_runs "$n" "$active"
    if ((failures > 0)); then die "$failures changes failed"; fi
    exit 0
    ;;
  *)
    echo "label ${FLEET_EVENT_LABEL}: nothing to do"
    exit 0
    ;;
esac

after_run=${FLEET_AFTER_RUN:-}
if [[ -n $after_run ]]; then
  [[ $after_run =~ ^[0-9]{1,20}$ ]] || die "FLEET_AFTER_RUN must be a run id"
  echo "started by task run $after_run, which is ending: it isn't counted as running"
fi

# Every job's GITHUB_TOKEN in this repo shares two budgets, REST and GraphQL, and a round can spend
# a lot of both. The marker post goes through both. Below the floor in either, the round leaves
# them to the outcome jobs, which must post their markers for the caps to count. The stop paths
# above always run, whatever the budget or the floor's value. A figure that can't be read doesn't
# hold a round back. A floor of 0 turns the guard off.
[[ $FLEET_BUDGET_FLOOR =~ ^(0|[1-9][0-9]{0,9})$ ]] ||
  die "FLEET_BUDGET_FLOOR must be digits only: 0 (no floor), or 1 to 9999999999 with no leading zero. Only the stop rounds run until it's fixed."
low=""
if [[ -n $BUDGET_REST ]] && ((BUDGET_REST < FLEET_BUDGET_FLOOR)); then
  low="$BUDGET_REST REST requests"
fi
if [[ -n $BUDGET_GRAPHQL ]] && ((BUDGET_GRAPHQL < FLEET_BUDGET_FLOOR)); then
  low="${low:+$low and }$BUDGET_GRAPHQL GraphQL points"
fi
if [[ -n $low ]]; then
  warn "fleet budget: $low left, below the floor of $FLEET_BUDGET_FLOOR. This round starts, closes, labels and cancels nothing and opens no final PR, to leave room for the outcome jobs' markers."
  exit 0
fi

issues=$(api_issues)
closed_now=""
started=0
failed_tasks=""
dispatched=""
if [[ $(jq length <<<"$issues") != 0 ]]; then
  active=$(api_active_runs)
  if [[ -n $after_run ]]; then
    active=$(jq --argjson id "$after_run" 'map(select(.databaseId != $id))' <<<"$active")
  fi
  running=$(jq '[.[] | select(.displayTitle | test("^task #[0-9]+$"))] | length' <<<"$active")
  slots=$((FLEET_MAX_JOBS - running))
  echo "task runs active: $running, cap $FLEET_MAX_JOBS"

  for n in $(jq -r '.[].number' <<<"$issues"); do
    issue=$(jq -c --argjson n "$n" '.[] | select(.number == $n)' <<<"$issues")
    # Each issue is decided in its own subshell, so an API error or a bad value in one issue skips
    # that issue with a warning and the round carries on.
    # Not inside an if: errexit must stay on in the subshell.
    set +e
    line=$(
      set -e
      decide "$n" "$issue" "$active"
      # \x1f, not a tab: read collapses runs of whitespace separators, and SEAT is often empty.
      printf '%s\x1f%s\x1f%s\x1f%s' "$DECISION" "$SEAT" "$PR_STATE" "$REASON"
    )
    rc=$?
    set -e
    if ((rc != 0)); then
      warn "#$n skipped this round: reading its state failed"
      continue
    fi
    IFS=$'\x1f' read -r DECISION SEAT PR_STATE REASON <<<"$line"
    if [[ $DECISION == start ]] && ((slots <= 0)); then
      DECISION=skip-full REASON="no free job slot"
    fi
    echo "#$n $DECISION pr=$PR_STATE: $REASON"
    case $DECISION in
      start)
        # Nothing in this loop may exit the round: the runs already started must still be waited
        # for, and the outputs below still emitted. A failure is counted and the loop carries on.
        if [[ ! $SEAT =~ ^[abc]$ ]]; then
          echo "::error::#$n: bad seat '$SEAT', not started"
          failures=$((failures + 1))
          continue
        fi
        # Strangers can't comment on a locked issue, so nothing they write reaches the agent there.
        if [[ $(jq -r .locked <<<"$issue") != true ]]; then
          try_act gh api -X PUT "repos/$FLEET_REPO/issues/$n/lock" --silent || continue
        fi
        # Stop all and fleet:stop run in their own groups, beside this round. The issue was read at
        # the start of the round, so read its labels again right before the dispatch.
        if ! fresh=$(api_issue "$n"); then
          echo "::error::#$n: reading the issue again before its start failed, not started"
          failures=$((failures + 1))
          continue
        fi
        if has_label "$fresh" fleet:stop; then
          echo "#$n got fleet:stop during this round, not started"
          continue
        fi
        # return_run_details must be a JSON boolean (-F): without it the endpoint answers 204 with
        # no body. With it, 200 and the new run's id, so the round can wait for that run below.
        if [[ $DRY_RUN == 1 ]]; then
          if try_act gh api -X POST "repos/$FLEET_REPO/actions/workflows/fleet.yml/dispatches" \
            -f ref=main -F return_run_details=true -f "inputs[issue]=$n" -f "inputs[seat]=$SEAT"; then
            slots=$((slots - 1))
            started=$((started + 1))
          fi
        elif body=$(gh api -X POST "repos/$FLEET_REPO/actions/workflows/fleet.yml/dispatches" \
          -f ref=main -F return_run_details=true -f "inputs[issue]=$n" -f "inputs[seat]=$SEAT"); then
          slots=$((slots - 1))
          started=$((started + 1))
          run_id=$(jq -r '.workflow_run_id // empty' <<<"$body" 2>/dev/null || true)
          if [[ $run_id =~ ^[0-9]+$ ]]; then
            echo "#$n started run $run_id"
            dispatched+="$n $run_id"$'\n'
          else
            echo "::error::#$n: the dispatch returned no run id, so this round can't wait for its run"
            failures=$((failures + 1))
          fi
        else
          echo "::error::failed: dispatch task #$n"
          failures=$((failures + 1))
        fi
        ;;
      done)
        if ! comment_on "$n" "Done: the PR from task/$n has merged." "$(jq -r .locked <<<"$issue")"; then
          echo "::error::failed: comment on #$n"
          failures=$((failures + 1))
        fi
        # In --dry-run the simulated close succeeds and counts as closed, so the dry run predicts
        # the final PR, and can differ from a real round whose close fails.
        if try_act gh issue close "$n" -R "$FLEET_REPO"; then closed_now+="$n "; fi
        ;;
      failed-cap)
        # The outcome job alerts for the caps it applies. These are the ones it left: a start cap
        # reached while the PR was set to merge, then dropped, or a label that failed there.
        if try_act gh issue edit "$n" -R "$FLEET_REPO" --add-label fleet:failed; then
          failed_tasks="${failed_tasks:+$failed_tasks }$n"
        fi
        ;;
      skip-stopped)
        # A stop event's run can fail or race a round, so every round also cancels whatever a
        # stopped task still has running.
        if jq -e --arg t "task #$n" 'any(.[]; .displayTitle == $t)' <<<"$active" >/dev/null; then
          cancel_task_runs "$n" "$active"
        fi
        ;;
    esac
  done
  echo "started: $started"
  if [[ -n $failed_tasks ]]; then emit failed_tasks "$failed_tasks"; fi
  # Rounds run one at a time, so a round that ends only once its runs are listed can't be
  # followed by one that misses them and starts the same task again.
  if [[ $DRY_RUN == 1 ]] && ((started > 0)); then
    echo "would wait for the $started started runs to show in the run list"
  elif [[ -n $dispatched ]]; then
    wait_for_runs "$dispatched"
    failures=$((failures + WAIT_MISSING))
  fi
fi

final_prs
if [[ -n $FINAL_URLS ]]; then emit final_prs "$FINAL_URLS"; fi
if [[ $(jq length <<<"$issues") == 0 && $FINAL_COUNT == 0 ]]; then
  echo "nothing to do"
fi
if ((failures > 0)); then die "$failures changes failed"; fi
