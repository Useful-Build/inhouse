# shellcheck shell=bash
# Shared by router.sh and task.sh. Sourced, never run on its own.
#
# Every GitHub read goes through an api_* function. With FLEET_FIXTURES set to a directory they read
# JSON files from it instead (same shapes the API returns), and FLEET_NOW fixes the clock, so the
# decisions can be tested without a network. See router-test.sh and classify-test.sh.
#
# Issue text never reaches the shell: JSON is read with jq, and only numbers, label names, logins
# and the validated base branch name come out of it.

MARKER_BOT="github-actions[bot]"
ACTIVE_STATUSES="queued in_progress waiting pending requested"
# A paused marker never asks to wait longer than this, whatever the task job claims.
MAX_PAUSE_SECONDS=$((8 * 24 * 3600))

die() {
  echo "fleet: $*" >&2
  exit 1
}

warn() { echo "::warning::$*"; }

is_number() { [[ $1 =~ ^[1-9][0-9]{0,9}$ ]]; }

fleet_init() {
  : "${FLEET_OWNER:?FLEET_OWNER is not set. Set the repo variable FLEET_OWNER to the login whose issues may start tasks.}"
  FLEET_MAX_JOBS=${FLEET_MAX_JOBS:-16}
  FLEET_MAX_STARTS=${FLEET_MAX_STARTS:-6}
  # Checked by the router only, after its stop paths, so a bad value can't block a stop.
  FLEET_BUDGET_FLOOR=${FLEET_BUDGET_FLOOR:-200}
  is_number "$FLEET_MAX_JOBS" || die "FLEET_MAX_JOBS must be a positive whole number"
  is_number "$FLEET_MAX_STARTS" || die "FLEET_MAX_STARTS must be a positive whole number"
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    [[ -d $FLEET_FIXTURES ]] || die "FLEET_FIXTURES is not a directory: $FLEET_FIXTURES"
    FLEET_REPO=${FLEET_REPO:-fixture/repo}
    DRY_RUN=1
  else
    FLEET_REPO=${FLEET_REPO:-${GITHUB_REPOSITORY:-}}
    if [[ -z $FLEET_REPO ]]; then
      FLEET_REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
    fi
  fi
  [[ $FLEET_REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "bad repo name: $FLEET_REPO"
  NOW=${FLEET_NOW:-$(date -u +%s)}
}

# Runs a command that changes GitHub, or only prints it in a dry run. In a dry run, a command that
# matches the glob in FLEET_ACT_FAIL fails, so the tests can follow a failed change.
act() {
  if [[ ${DRY_RUN:-0} == 1 ]]; then
    echo "  would run: $*"
    # shellcheck disable=SC2053 # the right side is a glob on purpose
    if [[ -n ${FLEET_ACT_FAIL:-} && "$*" == $FLEET_ACT_FAIL ]]; then
      echo "  (fails)"
      return 1
    fi
  else
    "$@"
  fi
}

# Posts a comment on issue or PR $1 with body $2. $3 is "true" when its conversation is locked.
# GitHub may refuse a bot's comment on a locked conversation, so a locked one is unlocked for the
# post and locked again right after, even when the post fails. Locking again is never fatal.
# Fails when the post fails.
comment_on() {
  local n=$1 body=$2 locked=$3 unlocked=false rc=0
  if [[ $locked == true ]]; then
    if act gh api -X DELETE "repos/$FLEET_REPO/issues/$n/lock" --silent; then
      unlocked=true
    else
      warn "unlocking #$n failed, posting anyway"
    fi
  fi
  act gh issue comment "$n" -R "$FLEET_REPO" --body "$body" || rc=$?
  if [[ $unlocked == true ]]; then
    act gh api -X PUT "repos/$FLEET_REPO/issues/$n/lock" --silent || warn "locking #$n again failed"
  fi
  return $rc
}

# Writes a step output in Actions, and always echoes it.
emit() {
  echo "$1=$2"
  if [[ -n ${GITHUB_OUTPUT:-} ]]; then echo "$1=$2" >>"$GITHUB_OUTPUT"; fi
}

# Prints both budgets this job's token has left, REST requests and GraphQL points (separate
# buckets of 1,000 an hour each for GITHUB_TOKEN), as one line:
#   fleet budget: REST 812/1000 resets 01:59 UTC, GraphQL 960/1000 resets 01:59 UTC (router start)
# $1 says where in the job it was read. Sets BUDGET_REST and BUDGET_GRAPHQL to what's left, each
# empty when it can't be read. A figure that can't be read is printed as "unreadable" on a warning
# line, never a failure. GET /rate_limit doesn't count against the budget. The fixture is
# rate_limit.json, and a missing one can't be read.
# shellcheck disable=SC2034 # BUDGET_REST and BUDGET_GRAPHQL are read by the router
budget() {
  local raw="" key name part line="" left limit reset unreadable=false
  BUDGET_REST="" BUDGET_GRAPHQL=""
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    raw=$(cat "$FLEET_FIXTURES/rate_limit.json" 2>/dev/null) || raw=""
  else
    raw=$(gh api rate_limit 2>/dev/null) || raw=""
  fi
  for key in core graphql; do
    if [[ $key == core ]]; then name=REST; else name=GraphQL; fi
    if part=$(jq -er --arg k "$key" '.resources[$k]
        | select([.remaining, .limit, .reset] | all(type == "number" and . >= 0 and . == floor))
        | "\(.remaining) \(.limit) \(.reset | strftime("%H:%M"))"' <<<"$raw" 2>/dev/null); then
      read -r left limit reset <<<"$part"
      line+="${line:+, }$name $left/$limit resets $reset UTC"
      if [[ $key == core ]]; then BUDGET_REST=$left; else BUDGET_GRAPHQL=$left; fi
    else
      line+="${line:+, }$name unreadable"
      unreadable=true
    fi
  done
  if [[ $unreadable == true ]]; then
    warn "fleet budget: $line ($1)"
  else
    echo "fleet budget: $line ($1)"
  fi
  return 0
}

fixture() {
  local f="$FLEET_FIXTURES/$1.json"
  [[ -f $f ]] || die "missing fixture $f"
  cat "$f"
}

# One part of issue-<n>.json: comments, blocked_by or pulls.
fixture_part() {
  fixture "issue-$1" | jq -e --arg k "$2" 'if has($k) then .[$k] else error("fixture has no \($k)") end'
}

# One part of final.json, the fixture for the final PR rule.
fixture_final() {
  fixture final | jq -e --arg k "$1" 'if has($k) then .[$k] else error("final.json has no \($k)") end'
}

# All pages of a REST list, as one array.
api_list() {
  gh api --paginate --slurp "$1" | jq 'add // []'
}

# Open issues labelled fleet, oldest first. /issues also lists PRs, which are dropped.
api_issues() {
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    fixture issues
  else
    api_list "repos/$FLEET_REPO/issues?state=open&labels=fleet&per_page=100"
  fi | jq 'map(select(.pull_request == null)) | sort_by(.created_at, .number)'
}

# Closed issues labelled fleet. Only the final PR rule reads them.
api_closed_issues() {
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    fixture_final closed_issues
  else
    api_list "repos/$FLEET_REPO/issues?state=closed&labels=fleet&per_page=100"
  fi | jq 'map(select(.pull_request == null))'
}

api_issue() {
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    fixture issues | jq -e --argjson n "$1" '.[] | select(.number == $n)'
  else
    gh api "repos/$FLEET_REPO/issues/$1"
  fi
}

api_comments() {
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    fixture_part "$1" comments
  else
    api_list "repos/$FLEET_REPO/issues/$1/comments?per_page=100"
  fi
}

# Issues that block this one (GitHub issue dependencies).
api_blocked_by() {
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    fixture_part "$1" blocked_by
  else
    api_list "repos/$FLEET_REPO/issues/$1/dependencies/blocked_by?per_page=100"
  fi
}

# PRs from task/<n> in this repo into the task's base branch, newest first, as
# [{number, state, isDraft, inQueue, autoMerge, checks, mergeable, locked}]. A fork PR from a branch that is
# also named task/<n>, or a PR into another base, is never the task's PR. GraphQL, because REST has
# no merge queue state. $2 is the base branch; without one no PR can be the task's.
api_pulls() {
  local n=$1 base=${2:-}
  if [[ -z $base ]]; then
    echo "[]"
    return
  fi
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    fixture_part "$n" pulls
  else
    # shellcheck disable=SC2016 # GraphQL variables, not shell ones
    gh api graphql \
      -f owner="${FLEET_REPO%%/*}" -f name="${FLEET_REPO##*/}" -f head="task/$n" -f base="$base" \
      -f query='query($owner: String!, $name: String!, $head: String!, $base: String!) {
        repository(owner: $owner, name: $name) {
          pullRequests(headRefName: $head, baseRefName: $base, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
            nodes {
              number state isDraft isInMergeQueue isCrossRepository baseRefName locked mergeable
              autoMergeRequest { enabledAt }
              commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
            }
          }
        }
      }'
  fi | jq --arg base "$base" '.data.repository.pullRequests.nodes
    | map(select(.isCrossRepository == false and .baseRefName == $base))
    | map({
        number, state, isDraft, locked, mergeable,
        inQueue: .isInMergeQueue,
        autoMerge: (.autoMergeRequest != null),
        checks: .commits.nodes[0].commit.statusCheckRollup.state
      })'
}

# Runs of fleet.yml that haven't finished, as [{databaseId, displayTitle, status}]. One request per
# status and page of 100. The REST list takes one status per request, and gh run list would add a
# workflow lookup to each. The fixture runs.json is the runs' workflow_runs entries, all statuses.
# A live run object is about 13 KB, and Linux refuses a program argument of 128 KB or more, so
# each page keeps only the three fields at once and the pages are joined on stdin, never passed as
# an argument. This always runs inside $(...), where errexit is off, so every step has its own die.
api_active_runs() {
  local s all="" page
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    all=$(fixture runs | jq -c '[.[] | {id, display_title, status}]') || die "reading the runs fixture failed"
  else
    for s in $ACTIVE_STATUSES; do
      page=$(gh api --paginate --slurp \
        "repos/$FLEET_REPO/actions/workflows/fleet.yml/runs?status=$s&exclude_pull_requests=true&per_page=100" |
        jq -c '[.[].workflow_runs[] | {id, display_title, status}]') || die "listing $s runs failed"
      all+=$page$'\n'
    done
  fi
  jq -s 'add | map({databaseId: .id, displayTitle: .display_title, status})' <<<"$all" ||
    die "joining the run lists failed"
}

# The status of one run (queued, in_progress, completed, ...), or "unknown" when it can't be read
# yet. The fixture is run-<id>.json, and a missing one is "unknown".
api_run_status() {
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    if [[ -f $FLEET_FIXTURES/run-$1.json ]]; then fixture "run-$1" | jq -r .status; else echo unknown; fi
  else
    gh api "repos/$FLEET_REPO/actions/runs/$1" --jq .status 2>/dev/null || echo unknown
  fi
}

# Waits until each run a round dispatched is in the active run list the next round will read
# (api_active_runs), or has finished. The list is a search, and it has missed a run for 20
# seconds and more after its dispatch, so finding the run by its id isn't enough. Checks up to
# 13 times with a 5 second sleep between checks: 60 seconds of sleep, plus the time the reads
# take (5 requests and more per check), so the wait runs longer than 60 seconds. A run list that
# can't be read is a warning naming the tasks, and the next check tries again. Each run that never shows gets an error naming its task, and
# WAIT_MISSING counts them. Never exits, so the caller still emits its outputs.
#   $1 lines of "<issue> <run id>"
WAIT_SECONDS=60
WAIT_POLL=5
wait_for_runs() {
  local pending=$1 still active n id waited=0
  WAIT_MISSING=0
  while [[ -n $pending ]]; do
    if ! active=$(api_active_runs); then
      warn "listing runs failed while waiting for $(awk 'NF { printf "%s#%s", s, $1; s = " " }' <<<"$pending"), trying again"
      active="[]"
    fi
    still=""
    while read -r n id; do
      [[ -n $n ]] || continue
      if jq -e --argjson id "$id" 'any(.[]; .databaseId == $id)' <<<"$active" >/dev/null; then
        echo "#$n run $id is in the run list"
      elif [[ $(api_run_status "$id" </dev/null) == completed ]]; then
        echo "#$n run $id has finished"
      else
        still+="$n $id"$'\n'
      fi
    done <<<"$pending"
    pending=$still
    if [[ -z $pending ]] || ((waited >= WAIT_SECONDS)); then break; fi
    # The fixtures never change, so the tests don't sleep.
    if [[ -z ${FLEET_FIXTURES:-} ]]; then sleep "$WAIT_POLL"; fi
    waited=$((waited + WAIT_POLL))
  done
  while read -r n id; do
    [[ -n $n ]] || continue
    echo "::error::#$n: its run $id isn't in the run list after $((WAIT_SECONDS / WAIT_POLL + 1)) checks ${WAIT_POLL}s apart and hasn't finished, so the next round may start task #$n again"
    WAIT_MISSING=$((WAIT_MISSING + 1))
  done <<<"$pending"
}

# Open issues labelled fleet at the end of a round, after the round's own closes. Live, a fresh
# api_issues. The fixture is final.json's open_issues, the list as GitHub returns it then.
api_issues_after_round() {
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    fixture_final open_issues | jq 'map(select(.pull_request == null))'
  else
    api_issues
  fi
}

# Branches named fleet/<topic>, as [{name, sha}] with each branch's head commit.
api_fleet_branches() {
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    fixture_final branches
  else
    api_list "repos/$FLEET_REPO/git/matching-refs/heads/fleet/?per_page=100" |
      jq 'map({name: (.ref | sub("^refs/heads/"; "")), sha: .object.sha})'
  fi
}

# How many commits a branch has that main doesn't.
api_ahead_of_main() {
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    fixture_final ahead | jq -e --arg b "$1" '.[$b]'
  else
    gh api "repos/$FLEET_REPO/compare/main...$1" --jq .ahead_by
  fi
}

# Open PRs from a branch of this repo into main, as an array.
api_prs_to_main() {
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    fixture_final prs_to_main | jq --arg b "$1" '.[$b] // []'
  else
    api_list "repos/$FLEET_REPO/pulls?state=open&base=main&head=${FLEET_REPO%%/*}:$1&per_page=100"
  fi
}

# Head commits of the closed, unmerged PRs from a branch of this repo into main, as an array.
api_closed_heads_to_main() {
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    fixture_final closed_prs_to_main | jq --arg b "$1" '.[$b] // []'
  else
    api_list "repos/$FLEET_REPO/pulls?state=closed&base=main&head=${FLEET_REPO%%/*}:$1&per_page=100"
  fi | jq 'map(select(.merged_at == null) | .head.sha)'
}

# Numbers of the merged PRs from this repo into a branch, oldest first.
api_merged_into() {
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    fixture_final merged | jq --arg b "$1" '.[$b] // []'
  else
    api_list "repos/$FLEET_REPO/pulls?state=closed&base=$1&per_page=100" |
      jq --arg repo "$FLEET_REPO" '[.[] | select(.merged_at != null and .head.repo.full_name == $repo)]
        | sort_by(.merged_at) | map(.number)'
  fi
}

# Whether a ref exists on the remote. Fails loudly on anything but "found" or "not found".
ref_exists() {
  local err
  if err=$(gh api "repos/$FLEET_REPO/git/ref/heads/$1" --silent 2>&1); then
    return 0
  fi
  [[ $err == *"HTTP 404"* ]] && return 1
  die "checking branch $1 failed: $err"
}

# The base branch named by an issue's "Base: fleet/<topic>" line, or nothing. Reads issue JSON.
issue_base() {
  jq -r '
    (.body // "") | split("\n") | map(sub("\r$"; ""))
    | map(capture("^Base: (?<b>fleet/[A-Za-z0-9._-]+)\\s*$").b) | first // empty'
}

# Outcome markers on an issue, oldest first: [{run, seat, outcome, retry_after, at}].
# Only comments by github-actions[bot] count, and the marker must be the whole first line.
markers() {
  api_comments "$1" | jq --arg bot "$MARKER_BOT" '
    [ .[]
      | select(.user.login == $bot and .user.type == "Bot")
      | .created_at as $at
      | .body | split("\n")[0] | sub("\r$"; "")
      | capture("^<!-- fleet:attempt run=(?<run>[0-9]+) seat=(?<seat>[abc]) outcome=(?<outcome>done|progress|paused|failed|cancelled) retry_after=(?<retry_after>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)? -->$")
      | .retry_after = (.retry_after // "")
      | . + {at: $at} ]
    | sort_by(.at)'
}

# Prints why a task may not start again, or nothing. Reads markers JSON on stdin.
cap_reason() {
  jq -r --argjson max "$FLEET_MAX_STARTS" '
    [ .[] | select(.outcome == "progress" or .outcome == "failed" or .outcome == "done") ] as $starts
    | if ($starts | length) >= $max then
        "\($starts | length) starts, cap is \($max)"
      elif ($starts | length) >= 2 and ($starts[-2:] | all(.outcome == "failed")) then
        "two failed runs in a row"
      else empty end'
}

# The seat for the next start. Rotation order starts at (issue number mod 3) and moves on by one
# for every earlier marker that isn't cancelled, so a pause moves it on too. A paused marker blocks
# its own seat for this task until its retry_after, or until an hour after the marker when
# retry_after is empty or can't be read. Takes the first seat in rotation order that isn't
# blocked, and prints it (a, b or c), or "until <time>" with the earliest time a seat frees when
# all three are blocked. A seat frees at its retry_after exactly.
#   $1 issue number. Reads markers JSON on stdin.
seat_choice() {
  jq -r --argjson n "$1" --argjson now "$NOW" '
    def time: try fromdateiso8601 catch null;
    (map(select(.outcome != "cancelled")) | length) as $k
    | [ .[] | select(.outcome == "paused")
        | {seat, until: ((.retry_after | if . == "" then null else time end) // (((.at | time) // 0) + 3600))} ]
      as $pauses
    | [ range(0; 3) | ["a", "b", "c"][($n + $k + .) % 3] as $s
        | {seat: $s, until: ([$pauses[] | select(.seat == $s) | .until] | max // 0)} ] as $order
    | ([$order[] | select(.until <= $now)][0].seat)
      // ("until " + ([$order[].until] | min | todate))'
}

# The state of a task's PR, from api_pulls JSON on stdin. One of:
#   merged     a PR merged
#   draft      the newest open PR is a draft
#   queued     ready, in the merge queue
#   conflicting ready, not queued, conflicts with its base (whatever auto-merge and checks say)
#   failing    ready, its checks failed or errored (whatever auto-merge says)
#   automerge  ready, auto-merge on, checks pending or passing
#   ready      ready, auto-merge off and not queued (dropped from the queue, or never queued)
#   none       no PR, or only closed unmerged ones
pr_state() {
  jq -r '
    if any(.[]; .state == "MERGED") then "merged"
    else
      ([.[] | select(.state == "OPEN")][0]) as $p
      | if $p == null then "none"
        elif $p.isDraft then "draft"
        elif $p.inQueue then "queued"
        elif $p.mergeable == "CONFLICTING" then "conflicting"
        elif ($p.checks == "FAILURE" or $p.checks == "ERROR") then "failing"
        elif $p.autoMerge then "automerge"
        else "ready" end
    end'
}

has_label() {
  jq -e --arg l "$2" 'any(.labels[]?; .name == $l)' <<<"$1" >/dev/null
}

# shellcheck disable=SC2034 # DECISION, REASON, SEAT and PR_STATE are read by the caller
# Decides what to do with one task issue, from real state only. Sets DECISION, REASON, PR_STATE
# (the pr_state word, or "-" when the decision came before reading the PR) and, for a start, SEAT.
#   $1 issue number, $2 issue JSON, $3 active runs JSON, or "self" when called from the task's own run
# Decisions: start, done, failed-cap, skip-running, skip-waiting, skip-blocked, skip-paused,
# skip-stopped, skip-failed, skip-author, skip-closed, skip-unlabelled.
decide() {
  local n=$1 issue=$2 active=$3 base pulls state open_no blockers mk cap seat
  DECISION="" REASON="" SEAT="" PR_STATE="-"

  if [[ $(jq -r .state <<<"$issue") != open ]]; then
    DECISION=skip-closed REASON="issue is closed"
    return
  fi
  if ! has_label "$issue" fleet; then
    DECISION=skip-unlabelled REASON="no fleet label"
    return
  fi
  if ! jq -e --arg o "$FLEET_OWNER" '((.user.login // "") | ascii_downcase) == ($o | ascii_downcase)' <<<"$issue" >/dev/null; then
    DECISION=skip-author REASON="author is not FLEET_OWNER"
    return
  fi

  base=$(issue_base <<<"$issue")
  pulls=$(api_pulls "$n" "$base")
  state=$(pr_state <<<"$pulls")
  PR_STATE=$state
  open_no=$(jq -r '[.[] | select(.state == "OPEN")][0].number // empty' <<<"$pulls")
  # Merged wins over every label: the work is in, so the issue closes.
  if [[ $state == merged ]]; then
    DECISION="done" REASON="PR #$(jq -r '[.[] | select(.state == "MERGED")][0].number' <<<"$pulls") merged"
    return
  fi
  if has_label "$issue" fleet:stop; then
    DECISION=skip-stopped REASON="has fleet:stop"
    return
  fi
  if has_label "$issue" fleet:failed; then
    DECISION=skip-failed REASON="has fleet:failed"
    return
  fi
  if [[ $active != self ]] &&
    jq -e --arg t "task #$n" 'any(.[]; .displayTitle == $t)' <<<"$active" >/dev/null; then
    DECISION=skip-running REASON="a task #$n run is queued or running"
    return
  fi
  case $state in
    queued)
      DECISION=skip-waiting REASON="PR #$open_no is in the merge queue"
      return
      ;;
    automerge)
      DECISION=skip-waiting REASON="PR #$open_no has auto-merge on and its checks haven't failed"
      return
      ;;
  esac

  blockers=$(api_blocked_by "$n" | jq -r '[.[] | select(.state == "open") | "#\(.number)"] | join(" ")')
  if [[ -n $blockers ]]; then
    DECISION=skip-blocked REASON="blocked by $blockers"
    return
  fi

  mk=$(markers "$n")
  cap=$(cap_reason <<<"$mk")
  if [[ -n $cap ]]; then
    DECISION=failed-cap REASON="$cap"
    return
  fi
  seat=$(seat_choice "$n" <<<"$mk")
  if [[ $seat == until* ]]; then
    DECISION=skip-paused REASON="every seat is paused on a usage limit, the first frees at ${seat#until }"
    return
  fi

  DECISION=start
  SEAT=$seat
  case $state in
    none) REASON="unfinished, no open PR" ;;
    draft) REASON="unfinished, draft PR #$open_no" ;;
    conflicting) REASON="unfinished, ready PR #$open_no conflicts with its base" ;;
    failing) REASON="unfinished, ready PR #$open_no has failed checks" ;;
    ready) REASON="unfinished, ready PR #$open_no has auto-merge off and isn't queued" ;;
  esac
}

# Classifies one finished task run. Prints the outcome to record, or "none" when nothing started.
#   $1 the task job's result: success, failure, cancelled or skipped ("" when unknown)
#   $2 whether its checkout ran: "true" or anything else
#   $3 the agent step's outcome: success, failure, cancelled, skipped or ""
#   $4 whether it claims a usage limit stopped it: "true" or anything else
#   $5 whether it ran to the agent's step timeout: "true" or anything else
#   $6 the PR state from pr_state
#   $7 whether the issue has fleet:stop: "true" or anything else
# Only $1, $6 and $7 are facts GitHub reports. $2 to $5 are what the task job says, and the agent
# can change what that job says (see FAILURES.md).
# A cancelled job is "cancelled" (not a start) only when the task is stopped. Any other cancel, a
# manual one or GitHub's own job timeout, is "progress", so it counts toward the start cap.
classify() {
  local result=$1 checkout=$2 agent=$3 paused=$4 timed_out=$5 state=$6 stopped=$7
  if [[ $result == skipped ]]; then
    echo none
  elif [[ $result == cancelled ]]; then
    if [[ $stopped == true ]]; then echo cancelled; else echo progress; fi
  elif [[ $checkout != true ]]; then
    # Never got to the agent. A clean refusal (stopped, capped, done) isn't a start. A job that
    # died here (an API error, no Base line, a lost runner with no outputs) is a failed start.
    if [[ $result == success ]]; then echo none; else echo failed; fi
  elif [[ $state == merged || $state == queued || $state == automerge ]]; then
    echo "done"
  elif [[ $paused == true && $agent != success ]]; then
    echo paused
  elif [[ $agent == success ]]; then
    echo progress
  elif [[ $agent == failure && $timed_out == true ]]; then
    echo progress
  else
    echo failed
  fi
}

# Whether a task job ran to the agent's step timeout: true when at least $2 minutes have passed
# since $1, the job's start time in epoch seconds (a claim: anything but a number means no). The
# agent step starts a few seconds after the job, so a step cut off at its timeout always counts.
ran_to_timeout() {
  [[ $1 =~ ^[0-9]{1,12}$ && $2 =~ ^[0-9]{1,4}$ ]] && ((NOW - $1 >= $2 * 60))
}

# shellcheck disable=SC2034 # RETRY_AFTER is read by the caller
# Sets RETRY_AFTER to a retry time that is safe to record: a valid ISO time no more than 8 days
# ahead, or empty (with a warning) when the claim can't be read.
clamp_retry_after() {
  local raw=$1 t
  RETRY_AFTER=""
  [[ -z $raw ]] && return 0
  if [[ ! $raw =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    ! t=$(jq -rn --arg r "$raw" '$r | fromdateiso8601' 2>/dev/null); then
    warn "retry_after isn't a time, recorded as empty"
    return 0
  fi
  if ((t > NOW + MAX_PAUSE_SECONDS)); then
    warn "retry_after is more than 8 days ahead, capped at 8 days"
    RETRY_AFTER=$(jq -rn --argjson t $((NOW + MAX_PAUSE_SECONDS)) '$t | todate')
  else
    RETRY_AFTER=$raw
  fi
}
