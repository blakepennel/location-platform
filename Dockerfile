# syntax=docker/dockerfile:1
#
# location-platform — one image for every service:
#   Node 24 (MCP servers, OAuth dev server, live poller) + Python (timeline-sync)
#   + Chromium (upstream's headless name resolver and one-time key retrieval)
#   + an optional virtual display served over the web (noVNC) for watching/driving the browser.
#
# No secrets or real data are baked in: everything stateful lives in /data (a volume).
# Everything runs as the unprivileged "node" user.
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates tini procps \
        python3 python3-venv python3-pip \
        chromium fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
        xvfb x11vnc fluxbox novnc websockify \
        systemd libtss2-esys-3.0.2-0 libtss2-rc0 libtss2-mu0 libtss2-tcti-device0 \
    && rm -rf /var/lib/apt/lists/*

# ---- OpenAI Secure MCP Tunnel client (static binary; used by the chatgpt-* services) ----
COPY --from=ghcr.io/openai/tunnel-client:v0.0.15 /usr/bin/tunnel-client /usr/local/bin/tunnel-client

# ---- container glue (root-owned, read-only for the app) ----
COPY docker/entrypoint.sh /usr/local/bin/lp-entrypoint
COPY docker/chromium-wrapper.sh /usr/local/bin/chromium-wrapper
COPY docker/timeline-sync-loop.sh /usr/local/bin/timeline-sync-loop
COPY docker/google-browser.sh /usr/local/bin/google-browser
COPY docker/google-password-set.sh /usr/local/bin/google-password-set
RUN chmod 0755 /usr/local/bin/lp-entrypoint /usr/local/bin/chromium-wrapper /usr/local/bin/timeline-sync-loop /usr/local/bin/google-browser /usr/local/bin/google-password-set \
    && mkdir -p /app /opt/venv /data \
    && chown node:node /app /opt/venv /data

USER node
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1

# ---- Node workspace deps ----
# Workspace sources are copied before `npm ci` because their package.json "bin" entries point at
# src/cli.ts files that must exist when npm links them.
COPY --chown=node:node package.json package-lock.json tsconfig.base.json ./
COPY --chown=node:node shared/ shared/
COPY --chown=node:node mcp-auth/ mcp-auth/
COPY --chown=node:node timeline-mcp/ timeline-mcp/
COPY --chown=node:node live-location-mcp/ live-location-mcp/
RUN npm ci --no-audit --no-fund

# ---- upstream timeline-export's own Node deps (puppeteer-core; drives the system Chromium) ----
COPY --chown=node:node timeline-sync/upstream/package.json timeline-sync/upstream/package-lock.json timeline-sync/upstream/
RUN npm ci --prefix timeline-sync/upstream --no-audit --no-fund

# ---- timeline-sync (editable install: it locates upstream/ relative to its own source) ----
COPY --chown=node:node timeline-sync/ timeline-sync/
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -e "./timeline-sync[dev]"

# ---- the rest of the source (tools/, schemas/, docs) ----
COPY --chown=node:node . .

ENV PATH=/opt/venv/bin:$PATH \
    LOCATION_PLATFORM_HOME=/data \
    MCP_BIND_HOST=0.0.0.0 \
    CHROME_PATH=/usr/local/bin/chromium-wrapper \
    BROWSER_MODE=headless \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

VOLUME ["/data"]
EXPOSE 8700 8701 8702 6080

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/lp-entrypoint"]
CMD ["sh", "-c", "echo 'location-platform image: choose a command (see DOCKER.md)'"]
