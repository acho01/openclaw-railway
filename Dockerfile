# Official release includes its matching Node runtime, Control UI, and Codex plugin.
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.9.2
FROM ${OPENCLAW_IMAGE}

# Preserve compatibility with the existing template's root-owned volume.
# Non-root execution requires a separate volume ownership migration.
USER root
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-venv \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV OPENCLAW_ENTRY=/app/openclaw.mjs
ENV OPENCLAW_STATE_DIR=/data/.openclaw
ENV OPENCLAW_WORKSPACE_DIR=/data/workspace
ENV NPM_CONFIG_PREFIX=/data/npm
ENV NPM_CONFIG_CACHE=/data/npm-cache
ENV PNPM_HOME=/data/pnpm
ENV PNPM_STORE_DIR=/data/pnpm-store
ENV PATH="/data/npm/bin:/data/pnpm:${PATH}"

# Keep wrapper dependencies separate from the official runtime in /app.
WORKDIR /railway-wrapper
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

# Validate the real release entry point during the image build.
RUN node --check src/server.js \
  && node --check src/slack-memory.js \
  && node --check src/slack-memory-status.js \
  && node --check src/slack-planner-manual.js \
  && node /app/openclaw.mjs --version \
  && node /app/openclaw.mjs gateway run --help

# Railway uses /setup/healthz; the inherited check assumes the upstream workdir.
HEALTHCHECK NONE
EXPOSE 8080
ENTRYPOINT ["tini", "-s", "--"]
CMD ["node", "src/server.js"]
