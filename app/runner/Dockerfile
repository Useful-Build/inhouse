# The runner image skeleton (P3 R0). R2 owns this file from here: the guards, the per-session OS users and the
# sandbox's packages go in there. The build context is app/ (so app/shared/ can be bundled); what it holds is in
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
WORKDIR /runner
COPY runner/package.json runner/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /runner/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.mjs"]
