#!/usr/bin/env bash
# Starts a feature: creates the branch fleet/<topic> from main and that branch's merge queue
# ruleset. Run it once per feature, as the repo owner, on your own machine (never in Actions).
#
#   new-feature.sh <topic>             create both
#   new-feature.sh <topic> --dry-run   print the two requests it would send, change nothing
#
# Why a ruleset per branch: GitHub refused a merge_queue rule on the fleet/** ruleset when we tried
# (its docs say the same for branch protection rules with a wildcard). So the "fleet branches"
# ruleset (.github/rulesets/fleet.json) covers fleet/** without one, and each feature branch gets
# its own "fleet/<topic> queue" ruleset with only the queue.
# The owner's admin bypass on fleet/** is what lets this create the branch.
#
# Env: FLEET_REPO (owner/name; default: the repo of the current directory). Needs gh logged in as
# a repo admin. Fails on a bad topic, a branch that exists or a ruleset that exists, before it
# changes anything.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=SCRIPTDIR/lib.sh
source "$here/lib.sh"

DRY_RUN=0
topic=""
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=1 ;;
    -*) die "unknown option: $arg (usage: new-feature.sh <topic> [--dry-run])" ;;
    *)
      [[ -z $topic ]] || die "one topic only (usage: new-feature.sh <topic> [--dry-run])"
      topic=$arg
      ;;
  esac
done

[[ ${GITHUB_ACTIONS:-} != true ]] || die "run this on your own machine as the owner, not in Actions"
[[ -n $topic ]] || die "usage: new-feature.sh <topic> [--dry-run]"
# The router and the task job accept fleet/<topic> only with these characters. Git also refuses
# a name part that starts with a dot, ends with .lock or holds "..".
if [[ ! $topic =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ || $topic == *..* || $topic == *.lock || $topic == *. ]]; then
  die "bad topic '$topic': use letters, digits, '.', '_' and '-', starting with a letter or digit"
fi

FLEET_REPO=${FLEET_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
[[ $FLEET_REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "bad repo name: $FLEET_REPO"
branch="fleet/$topic"
ref="refs/heads/$branch"
name="$branch queue"

# Every check comes before any change.
if ref_exists "$branch"; then die "branch $branch already exists"; fi
existing=$(gh api --paginate --slurp "repos/$FLEET_REPO/rulesets?includes_parents=false&per_page=100" |
  jq -r 'add // [] | .[].id') || die "listing the rulesets failed"
for id in $existing; do
  rs=$(gh api "repos/$FLEET_REPO/rulesets/$id") || die "reading ruleset $id failed"
  if jq -e --arg n "$name" --arg r "$ref" \
    '.name == $n or any(.conditions.ref_name.include[]?; . == $r)' <<<"$rs" >/dev/null; then
    die "ruleset $id ($(jq -r .name <<<"$rs")) already exists for $branch"
  fi
done
sha=$(gh api "repos/$FLEET_REPO/git/ref/heads/main" --jq .object.sha) || die "reading main failed"
[[ $sha =~ ^[0-9a-f]{40}$ ]] || die "main's head commit is unreadable"

branch_body=$(jq -n --arg ref "$ref" --arg sha "$sha" '{ref: $ref, sha: $sha}')
# Same queue settings as main's ruleset, and the same owner-only bypass (repository role 5, admin).
ruleset_body=$(jq -n --arg name "$name" --arg ref "$ref" '{
  name: $name,
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: [$ref], exclude: [] } },
  bypass_actors: [ { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" } ],
  rules: [ {
    type: "merge_queue",
    parameters: {
      check_response_timeout_minutes: 60,
      grouping_strategy: "ALLGREEN",
      max_entries_to_build: 1,
      max_entries_to_merge: 1,
      merge_method: "MERGE",
      min_entries_to_merge: 1,
      min_entries_to_merge_wait_minutes: 0
    }
  } ]
}')

if [[ $DRY_RUN == 1 ]]; then
  echo "would send: POST repos/$FLEET_REPO/git/refs"
  echo "$branch_body"
  echo "would send: POST repos/$FLEET_REPO/rulesets"
  echo "$ruleset_body"
  exit 0
fi

gh api -X POST "repos/$FLEET_REPO/git/refs" --input - --silent <<<"$branch_body" ||
  die "creating $branch failed. Nothing was changed."
echo "created $branch at $sha"
if ! id=$(gh api -X POST "repos/$FLEET_REPO/rulesets" --input - --jq .id <<<"$ruleset_body"); then
  die "$branch exists but its queue ruleset wasn't created, so its task PRs can't use the merge queue.
Delete the branch (gh api -X DELETE repos/$FLEET_REPO/git/refs/heads/$branch) and run this again."
fi
echo "created ruleset $id ($name)"
