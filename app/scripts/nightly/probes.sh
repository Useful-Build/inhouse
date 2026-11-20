#!/bin/sh
# The nightly's guard probes (step 1): R2's probe bundle run in the runner image built from the checked-out code (main).
# The docker run flags are ci.yml's runner job's, to the letter; nightly.test.mjs fails when they differ. Needs Docker and
# sudo (the same two host settings as ci.yml's "Probe setup"). Run from anywhere; exit 1 on any probe FAIL.
set -eu
app="$(cd "$(dirname "$0")/../.." && pwd)"
MADE_TMP=""
if [ -z "${RUNNER_TEMP:-}" ]; then
  RUNNER_TEMP="$(mktemp -d)"
  MADE_TMP="$RUNNER_TEMP"
fi
GW_PID=""
cleanup() {
  [ -z "$GW_PID" ] || kill "$GW_PID" 2>/dev/null || true
  [ -z "$MADE_TMP" ] || rm -rf "$MADE_TMP"
}
trap cleanup EXIT
cd "$app/runner"
npm ci
docker build -f Dockerfile -t inhouse-runner:nightly ..
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0; fi
if [ -e /etc/apparmor.d/bwrap-userns-restrict ]; then sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict; fi
sh image/probes/build.sh "$RUNNER_TEMP/probes"
mkdir -p "$RUNNER_TEMP/gw" && echo GW_OK > "$RUNNER_TEMP/gw/probe.txt"
if python3 -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1', 18080)) == 0 else 1)"; then
  echo "port 18080 is already in use: the probes' gateway server can't start" >&2
  exit 1
fi
nohup python3 -m http.server 18080 --bind 0.0.0.0 --directory "$RUNNER_TEMP/gw" > /dev/null 2>&1 &
GW_PID=$!
docker run --rm --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined \
  -v "$RUNNER_TEMP/probes:/opt/runner/probes:ro" -e PROBE_GW_PORT=18080 inhouse-runner:nightly node /opt/runner/probes/run.mjs
