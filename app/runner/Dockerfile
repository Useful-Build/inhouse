# The runner image (P3 R0, R2's guards). The build context is app/ (so app/shared/ can be bundled); what it holds is in
# Dockerfile.dockerignore, next to this file. Build it as CI does, from app/runner/:
#   docker build -f Dockerfile -t inhouse-runner ..
# Build stage (P3 R1): bundle the root entry and the session entry with app/shared/protocol/, zod resolved from the
# runner's own node_modules (never app/node_modules). The Agent SDK stays external: it spawns its own CLI.
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
WORKDIR /runner
COPY runner/package.json runner/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY runner/src ./src
COPY shared/protocol /shared/protocol
RUN npm run build

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
# - bubblewrap, socat: the Agent SDK's Bash sandbox on Linux (ripgrep ships inside the CLI).
# - tini: PID 1 reaps orphans, so a session's leftovers don't linger as zombies the pool's release would wait on.
# - python3 and its libraries: the file skills (PDF, Word, spreadsheet; decision Q7).
# Pinned to bookworm's versions: a build fails loudly when Debian replaces one, and the pin is bumped then.
# Pins checked 2026-11-19. To bump: `docker run --rm <the base image above> sh -c 'apt-get update -qq && apt-cache policy
# <package>'`, take each package's Candidate version, update it here and the date above, and let CI's runner job build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bubblewrap=0.8.0-2+deb12u1 \
      socat=1.7.4.4-2 \
      tini=0.19.0-1+b3 \
      procps=2:4.0.2-3 \
      python3=3.11.2-1+b1 \
      python3-reportlab=3.6.12-1+deb12u1 \
      python3-pypdf=3.4.1-1+deb12u1 \
      python3-docx=0.8.11+dfsg1-5 \
      python3-openpyxl=3.0.9-1 \
 && rm -rf /var/lib/apt/lists/*

# The session user pool, made here so nothing writes /etc/passwd at run time: s00..s63, each with its own uid and group
# (30000 up), no login shell and no home outside the work tree (the runner sets HOME to the session folder's .home).
RUN set -eu; for n in $(seq 0 63); do \
      name=$(printf 's%02d' "$n"); id=$((30000 + n)); \
      groupadd --gid "$id" "$name"; \
      useradd --uid "$id" --gid "$id" --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$name"; \
    done

# The runner's code, root-owned and read-only. Session processes run from it (their entry and the SDK), so it stays
# world-readable; Bash can't read it (the sandbox's denyRead) and the agent's Read tool is denied it (permission rules).
WORKDIR /opt/runner
COPY runner/package.json runner/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /runner/dist ./dist
# Our skills, as a plugin: root-owned and read-only. /work is 0711: bwrap and each session reach the session's own
# folder, but no session can list the chat ids. The wipe runs find and ipcrm (findutils, util-linux: always installed).
COPY runner/image/plugin /opt/inhouse/plugin
# The CLI as each session starts it: image/bin/claude sets the session's process limit (RLIMIT_NPROC, prlimit from
# util-linux), then runs the SDK's own CLI for this platform, linked here as claude-cli (the build fails if it's missing).
COPY runner/image/bin/claude /opt/inhouse/bin/claude
RUN cli="/opt/runner/node_modules/@anthropic-ai/claude-agent-sdk-linux-$(node -p process.arch)/claude" \
 && test -x "$cli" && test -x /usr/bin/prlimit \
 && ln -s "$cli" /opt/inhouse/bin/claude-cli
# The sandbox's seccomp filter (Unix sockets blocked, `allowAllUnixSockets: false`) needs nothing here: the pinned CLI
# carries its own apply-seccomp (the container probe saw it run with no global @anthropic-ai/sandbox-runtime, and
# checks a sandboxed command can't make a Unix socket).
RUN chown -R root:root /opt/runner /opt/inhouse \
 && chmod -R go-w,a+rX /opt/runner /opt/inhouse \
 && mkdir -m 0711 /work

# The root runner runs as root: it starts each session as that session's own pool user.
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/runner/dist/main.mjs"]
