#!/bin/sh
# The image's entrypoint (under tini): trust Cloudflare's intercept CA, then run the root runner (or the command given).
#
# Cloudflare Containers' outbound-traffic docs (read 2026-11-20): with HTTPS interception on, an ephemeral CA is created
# at /etc/cloudflare/certs/cloudflare-containers-ca.crt, there when the entrypoint runs (the Runner object registers its
# intercepts before start()); copy it into the distro's trust store from the entrypoint (never at build time: it exists
# only at run time), and point runtimes with their own bundle at it (NODE_EXTRA_CA_CERTS). Claude Code reads
# NODE_EXTRA_CA_CERTS and the system store (its network-config page, read 2026-11-20). The root passes
# NODE_EXTRA_CA_CERTS on to every session (src/session/env.ts).
#
# Absent (local runs, CI): logged once and the runner starts anyway; HTTPS through the intercept then fails closed.
set -eu
ca="${INHOUSE_CA_FILE:-/etc/cloudflare/certs/cloudflare-containers-ca.crt}"
trust_dir="${INHOUSE_CA_TRUST_DIR:-/usr/local/share/ca-certificates}"
wait_s="${INHOUSE_CA_WAIT_SECONDS:-5}"

# Bounded wait for the file, whole: a file still being written passes `-s`, so it counts only once it ends with a
# complete certificate (the docs say it's there at start; this covers a slow mount or write).
complete() { [ -s "$ca" ] && tail -c 64 "$ca" | grep -q -- '-----END CERTIFICATE-----'; }
i=0
while ! complete && [ "$i" -lt "$wait_s" ]; do
  sleep 1
  i=$((i + 1))
done

if [ -e "$ca" ] && ! complete; then
  # There, but not a whole certificate after the wait: stop rather than trust half a file or run without it.
  printf '{"type":"intercept_ca","found":true,"complete":false}\n'
  exit 1
fi

if complete; then
  # The image pins ca-certificates (its build checks the tool is there), so the system store always takes it; a
  # failed update stops the container rather than running with an intercept nothing but Node trusts.
  # The copy is world-readable (0644): sessions run as non-root pool users, and the source file may be root-only.
  # NODE_EXTRA_CA_CERTS names that copy, so every session's Node and CLI can read it.
  mkdir -p "$trust_dir"
  install -m 0644 "$ca" "$trust_dir/cloudflare-containers-ca.crt"
  update-ca-certificates >/dev/null
  store=system
  export NODE_EXTRA_CA_CERTS="$trust_dir/cloudflare-containers-ca.crt"
  printf '{"type":"intercept_ca","found":true,"systemStore":"%s"}\n' "$store"
else
  printf '{"type":"intercept_ca","found":false}\n'
fi

if [ "$#" -eq 0 ]; then set -- node /opt/runner/dist/main.mjs; fi
exec "$@"
