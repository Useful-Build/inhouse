# The runner image skeleton (P3 R0). R2 owns this file from here: the guards, the per-session OS users and the
# sandbox's packages go in there. The build context is app/ (so app/shared/ can be bundled later); what it holds is in
# Dockerfile.dockerignore, next to this file. Build it as CI does, from app/runner/:
#   docker build -f Dockerfile -t inhouse-runner ..
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
WORKDIR /runner
COPY runner/package.json runner/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY runner/src ./src
USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]
