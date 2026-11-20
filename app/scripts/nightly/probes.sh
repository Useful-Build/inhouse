#!/bin/sh
# The nightly's guard probes (step 1): R2's probe bundle run in the runner image built from the checked-out code (main).
# The docker run flags are ci.yml's runner job's, to the letter; nightly.test.mjs fails when they differ. Needs Docker and
# sudo (the same two host settings as ci.yml's "Probe setup"). Run from anywhere; exit 1 on any probe FAIL.
set -eu
app="$(cd "$(dirname "$0")/../.." && pwd)"
RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
cd "$app/runner"
npm ci
docker build -f Dockerfile -t inhouse-runner:nightly ..
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0; fi
if [ -e /etc/apparmor.d/bwrap-userns-restrict ]; then sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict; fi
sh image/probes/build.sh "$RUNNER_TEMP/probes"
mkdir -p "$RUNNER_TEMP/gw" && echo GW_OK > "$RUNNER_TEMP/gw/probe.txt"
nohup python3 -m http.server 18080 --bind 0.0.0.0 --directory "$RUNNER_TEMP/gw" > /dev/null 2>&1 &
docker run --rm --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined \
  -v "$RUNNER_TEMP/probes:/opt/runner/probes:ro" -e PROBE_GW_PORT=18080 inhouse-runner:nightly node /opt/runner/probes/run.mjs
