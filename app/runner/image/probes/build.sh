#!/bin/sh
# Bundles the container probes (run.ts, direct.ts) and their helper into one folder for CI's runner job to mount
# read-only at /opt/runner/probes. Run from app/runner/ after `npm ci`:  sh image/probes/build.sh <out dir>
# The Agent SDK stays external: inside the image it resolves from /opt/runner/node_modules, as the runner's own does.
set -eu
out="$1"
mkdir -p "$out"
npx esbuild image/probes/run.ts image/probes/direct.ts --bundle --platform=node --target=node26 --format=esm \
  --outdir="$out" --out-extension:.js=.mjs --external:@anthropic-ai/claude-agent-sdk \
  --alias:zod=./node_modules/zod/index.js --log-level=warning
cp image/probes/sysv.py "$out/sysv.py"
chmod -R a+rX "$out"
