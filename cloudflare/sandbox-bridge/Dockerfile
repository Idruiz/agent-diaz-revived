# Agent Díaz V2 Cloudflare Sandbox image.
# Keep this tag aligned with @cloudflare/sandbox in package.json.
FROM node:22.12.0-bookworm-slim AS node-runtime

FROM docker.io/cloudflare/sandbox:0.12.9

USER root

# Reuse the exact Node runtime supported by the Agent Díaz app. The Cloudflare
# sandbox base is Debian-based but intentionally minimal.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -sf /usr/local/lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack

# Chromium and normal workspace tooling live INSIDE the same Linux container as
# /workspace. Playwright, Puppeteer, shell, and filesystem MCP therefore see the
# same namespace instead of a Render-host copy.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    fonts-liberation \
    git \
    jq \
    procps \
    ripgrep \
    sed \
    gawk \
    tar \
    wget \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Pin the browser/MCP layer so a deploy cannot silently change tool behavior.
RUN npm install -g --omit=dev \
    @playwright/mcp@0.0.80 \
    chrome-devtools-mcp@1.8.0 \
    @modelcontextprotocol/server-filesystem@0.6.3

# SDK used only by the in-image verification/client scripts plus direct
# Puppeteer automation. Keeping it under /opt gives scripts deterministic ESM
# resolution without relying on NODE_PATH.
RUN mkdir -p /opt/agent-diaz-tools \
    && npm install --prefix /opt/agent-diaz-tools --omit=dev \
      @modelcontextprotocol/sdk@1.30.0 \
      puppeteer-core@25.9.0

COPY scripts/browser-smoke.mjs /opt/agent-diaz-tools/browser-smoke.mjs
COPY scripts/mcp-smoke.mjs /opt/agent-diaz-tools/mcp-smoke.mjs

RUN mkdir -p /workspace \
    && if ! id sandbox >/dev/null 2>&1; then useradd -m -s /bin/bash -d /home/sandbox sandbox; fi \
    && chown sandbox:sandbox /workspace /opt/agent-diaz-tools \
    && chmod 700 /root

USER sandbox
WORKDIR /workspace
