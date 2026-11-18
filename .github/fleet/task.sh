#!/usr/bin/env bash
# Steps of the fleet task and outcome jobs. Each subcommand writes its results as step outputs.
#
# Task job (the agent's job: it reads GitHub and writes nothing there but its own branch):
#   task.sh check <n>      may this task run now? outputs issue, go
#   task.sh base <n>       the base branch from the issue's "Base: fleet/<topic>" line. outputs base
#   task.sh branch <n>     what to check out: task/<n> if it exists, else the base. outputs ref, exists
#   task.sh usage <n>      did a usage limit stop the agent? outputs paused, retry_after
#   task.sh pr-state <n>   the task PR's state (lib.sh pr_state), for the checkpoint. outputs pr_state
# Outcome job (its own runner, scripts from main, never anything from the task job's runner):
#   task.sh outcome <n>    classify the run, post its marker, apply the caps, lock the PR.
#                          outputs outcome, failed_for_good, next_round
#
# Add --dry-run to print what would change instead. Env as in router.sh, plus BASE for branch and
# pr-state, EXECUTION_FILE for usage, and for outcome: RUN_ID, SEAT, TASK_RESULT, CHECKOUT_RAN,
# AGENT_OUTCOME, PAUSED, RETRY_AFTER, STARTED, AGENT_TIMEOUT_MINUTES.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=SCRIPTDIR/lib.sh
source "$here/lib.sh"

DRY_RUN=0
args=()
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=1 ;;
    *) args+=("$arg") ;;
  esac
done
[[ ${#args[@]} == 2 ]] || die "usage: task.sh check|base|branch|usage|pr-state|outcome <issue> [--dry-run]"
cmd=${args[0]} n=${args[1]}
is_number "$n" || die "issue must be a number"
fleet_init

notice() { echo "::notice::$*"; }

# Prefixes Claude Code puts on a message when a subscription usage limit stops it. From
# USAGE_LIMIT_ERROR_PREFIXES in @anthropic-ai/claude-agent-sdk 0.3.326 (sdk.d.ts), the SDK version
# claude-code-action v1 pins. Only used when no rate_limit_event says so.
USAGE_LIMIT_PREFIXES=$(
  cat <<'JSON'
["You've hit your", "You've reached your", "You're out of usage credits",
 "Your org is out of usage", "Your seat type doesn't include usage",
 "Your usage allocation has been disabled", "Your group's usage limit is set to $0",
 "You're out of extra usage", "Your seat type doesn't include extra usage"]
JSON
)

# THE usage-limit matcher. Reads the action's execution file (a JSON array of Agent SDK messages)
# and prints "paused <retry_after>" when a usage limit stopped the run, or nothing.
# 1. Structured: the NEWEST rate_limit_event only. It's a stop when rate_limit_info.status is
#    "rejected" and overage isn't carrying the session (SDKRateLimitInfo in sdk.d.ts 0.3.326:
#    isUsingOverage, overageInUse, overageStatus "allowed" or "allowed_warning"). Its resetsAt
#    (epoch seconds, or milliseconds when it's that large) becomes retry_after.
# 2. Text: the result message, or an assistant message with error "rate_limit", starts with one
#    of the prefixes above. No reset time is parsed from the text, so retry_after stays empty.
# Fails (jq exit code) on a file it can't read; the caller turns that into "not paused".
match_usage_limit() {
  local file=$1
  [[ -n $file && -s $file ]] || return 0
  jq -r --argjson prefixes "$USAGE_LIMIT_PREFIXES" '
    def limited: type == "string" and (. as $t | any($prefixes[]; . as $p | $t | startswith($p)));
    ([ .[] | select(.type == "rate_limit_event") ] | last) as $event
    | ($event.rate_limit_info // {}) as $info
    | if $event != null and $info.status == "rejected"
         and ($info.isUsingOverage != true) and ($info.overageInUse != true)
         and (($info.overageStatus // "") | . != "allowed" and . != "allowed_warning") then
        ($info.resetsAt // null) as $r
        | "paused " + (if $r == null then "" elif $r > 100000000000 then ($r / 1000 | floor | todate) else ($r | floor | todate) end)
      elif any(.[]; (.type == "result" and (.result | limited))
                 or (.type == "assistant" and .error == "rate_limit"
                     and any(.message.content[]?; .type == "text" and (.text | limited)))) then
        "paused "
      else empty end' "$file"
}

cmd_check() {
  local issue
  emit issue "$n"
  if [[ -n ${FLEET_FIXTURES:-} ]]; then
    issue=$(api_issue "$n")
  elif ! issue=$(api_issue "$n" 2>&1); then
    if [[ $issue == *"HTTP 404"* ]]; then
      notice "#$n not started: no such issue"
      emit go false
      return
    fi
    die "reading issue #$n failed: $issue"
  fi
  if jq -e '.pull_request != null' <<<"$issue" >/dev/null; then
    notice "#$n not started: it's a pull request"
    emit go false
    return
  fi
  decide "$n" "$issue" self
  if [[ $DECISION == start ]]; then
    echo "#$n start: $REASON"
    emit go true
  else
    # Read-only: a capped task is labelled by the outcome job or the router, not here.
    notice "#$n not started ($DECISION): $REASON"
    emit go false
  fi
}

cmd_base() {
  local base
  base=$(api_issue "$n" | issue_base)
  [[ -n $base ]] || die "issue #$n has no line \"Base: fleet/<topic>\". Add one and restart."
  # Belt and braces: only this pattern ever leaves this function.
  [[ $base =~ ^fleet/[A-Za-z0-9._-]+$ ]] || die "bad base branch name"
  if [[ -z ${FLEET_FIXTURES:-} ]] && ! ref_exists "$base"; then
    die "base branch $base doesn't exist. Create it from main first."
  fi
  emit base "$base"
}

cmd_branch() {
  local base=${BASE:?BASE is not set}
  if ref_exists "task/$n"; then
    emit ref "task/$n"
    emit exists true
  else
    emit ref "$base"
    emit exists false
  fi
}

cmd_usage() {
  local paused
  if ! paused=$(match_usage_limit "${EXECUTION_FILE:-}" 2>/dev/null); then
    echo "::warning::the execution file isn't a list of SDK messages, so the run isn't treated as paused"
    paused=""
  fi
  if [[ -n $paused ]]; then
    emit paused true
    emit retry_after "${paused#paused }"
  else
    emit paused false
    emit retry_after ""
  fi
}

cmd_pr_state() {
  local base=${BASE:?BASE is not set} state
  # On its own line, so a failed read fails the step (and the checkpoint warns) instead of
  # emitting an empty state.
  state=$(api_pulls "$n" "$base" | pr_state)
  emit pr_state "$state"
}

# Prints $1 when it's one of the other arguments, else "invalid". A claim is never printed raw:
# a task job output can hold a newline and a workflow command (::...::) after it.
known() {
  local v=$1 ok
  shift
  for ok in "$@"; do
    if [[ $v == "$ok" ]]; then
      echo "$v"
      return
    fi
  done
  echo invalid
}

cmd_outcome() {
  local run_id=${RUN_ID:?RUN_ID is not set} seat=${SEAT:-} started=${STARTED:-}
  local issue base pulls state stopped=false timed_out=false outcome line mk cap failed=false pr_no
  local result checkout agent paused
  local limit=${AGENT_TIMEOUT_MINUTES:-55}
  [[ $run_id =~ ^[0-9]+$ ]] || die "RUN_ID must be a number"

  issue=$(api_issue "$n")
  base=$(issue_base <<<"$issue")
  pulls=$(api_pulls "$n" "$base")
  state=$(pr_state <<<"$pulls")
  if has_label "$issue" fleet:stop; then stopped=true; fi
  # STARTED is the task job's start time, a claim. Anything but a number means no timeout.
  if ran_to_timeout "$started" "$limit"; then timed_out=true; fi

  result=$(known "${TASK_RESULT:-}" success failure cancelled skipped "")
  checkout=$(known "${CHECKOUT_RAN:-}" true false "")
  agent=$(known "${AGENT_OUTCOME:-}" success failure cancelled skipped "")
  paused=$(known "${PAUSED:-}" true false "")
  outcome=$(classify "$result" "$checkout" "$agent" "$paused" "$timed_out" "$state" "$stopped")
  echo "task job: result=$result checkout_ran=$checkout agent=$agent paused=$paused timed_out=$timed_out pr=$state stopped=$stopped"
  if [[ $outcome == none ]]; then
    notice "#$n run $run_id didn't start the agent, so no marker"
    emit outcome none
    emit failed_for_good false
    emit next_round false
    return
  fi
  # Exact, letter case included: GitHub's own comparisons (contains, ==) ignore case.
  [[ $seat =~ ^[abc]$ ]] || die "SEAT must be a, b or c"

  # 1. The marker. Without it the run isn't counted, so a failed post fails the job.
  RETRY_AFTER_SAFE=""
  if [[ $outcome == paused ]]; then
    clamp_retry_after "${RETRY_AFTER:-}"
    RETRY_AFTER_SAFE=$RETRY_AFTER
  fi
  case $outcome in
    done) line="Run $run_id on seat $seat: done. The PR is ready and set to merge." ;;
    progress) line="Run $run_id on seat $seat: progress saved, not finished. The router starts it again." ;;
    paused) line="Run $run_id on seat $seat: paused on a usage limit${RETRY_AFTER_SAFE:+ until $RETRY_AFTER_SAFE}. The router starts it again after that." ;;
    cancelled) line="Run $run_id on seat $seat: cancelled." ;;
    failed) line="Run $run_id on seat $seat: failed. See the run log." ;;
  esac
  comment_on "$n" "<!-- fleet:attempt run=$run_id seat=$seat outcome=$outcome retry_after=$RETRY_AFTER_SAFE -->
$line" "$(jq -r .locked <<<"$issue")" || die "posting the marker on #$n failed"

  # 2. The caps, after every marker, done included. A start cap reached while the PR is merged,
  # queued or set to merge isn't a failure yet: if the PR drops, the router labels it and alerts.
  mk=$(markers "$n")
  if [[ ${DRY_RUN:-0} == 1 ]]; then
    # The marker above wasn't posted, so count it here.
    mk=$(jq --arg o "$outcome" --argjson now "$NOW" '. + [{outcome: $o, retry_after: "", at: ($now | todate)}]' <<<"$mk")
  fi
  cap=$(cap_reason <<<"$mk")
  if [[ -n $cap ]] && ! has_label "$issue" fleet:failed; then
    if [[ $state == merged || $state == queued || $state == automerge ]]; then
      notice "#$n reached a cap ($cap), but its PR is $state, so it isn't marked fleet:failed"
    else
      echo "::warning::#$n marked fleet:failed: $cap"
      act gh issue edit "$n" -R "$FLEET_REPO" --add-label fleet:failed
      failed=true
    fi
  fi

  # 3. The outputs. Nothing after this line can stop them from being set.
  emit outcome "$outcome"
  emit failed_for_good "$failed"
  # Whether this run's next-round job starts a router round now. Only after a start (progress,
  # failed or done), so every link in this chain of rounds counts toward the start cap and the
  # chain ends. Not after "paused": it isn't a start, and its retry_after has no lower bound, so a
  # false claim could restart the task at once without end. A paused task waits for the next
  # round from another trigger. Not after "none" or "cancelled" either.
  case $outcome in
    progress | failed | done) emit next_round true ;;
    *) emit next_round false ;;
  esac

  # 4. Strangers can't comment on a locked PR, so nothing they write reaches the next run there.
  pr_no=$(jq -r '[.[] | select(.state == "OPEN" and .locked != true)][0].number // empty' <<<"$pulls")
  if [[ -n $pr_no ]]; then
    act gh api -X PUT "repos/$FLEET_REPO/issues/$pr_no/lock" --silent || warn "locking PR #$pr_no failed"
  fi
  return 0
}

case $cmd in
  check) cmd_check ;;
  base) cmd_base ;;
  branch) cmd_branch ;;
  usage) cmd_usage ;;
  pr-state) cmd_pr_state ;;
  outcome)
    # Printed on every way out, a failed marker post included.
    trap 'budget "outcome end"' EXIT
    cmd_outcome
    ;;
  *) die "unknown subcommand: $cmd" ;;
esac
