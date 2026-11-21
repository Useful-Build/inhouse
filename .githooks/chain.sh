# Sourced by the repo hooks. chain_hooks NAME [args]: after the repo hook's own check passed, runs the global hook of
# the same name (core.hooksPath in the global config) if executable, then the repo's own .git/hooks/NAME if
# executable. Returns the last chained hook's status. A global hook that already runs .git/hooks/NAME itself (it
# mentions git-common-dir) isn't followed by a second run of that hook.
chain_hooks() {
  name=$1
  shift
  status=0
  g=$(git config --global core.hooksPath 2>/dev/null || true)
  case "$g" in "~"*) g="$HOME${g#"~"}" ;; esac
  global=""
  if [ -n "$g" ] && [ -x "$g/$name" ] && [ "$(cd "$g" && pwd -P)" != "$(cd "$(dirname "$0")" && pwd -P)" ]; then
    global="$g/$name"
    "$global" "$@" || status=$?
  fi
  local_hook="$(git rev-parse --git-common-dir)/hooks/$name"
  if [ -x "$local_hook" ] && ! { [ -n "$global" ] && grep -q 'git-common-dir' "$global"; }; then
    "$local_hook" "$@" || status=$?
  fi
  return "$status"
}
