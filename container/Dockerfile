FROM node:22-slim

# Install FUSE, git, python, and common tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    fuse3 \
    bash \
    git \
    python3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src/ src/
COPY scripts/ scripts/
RUN npx tsc && chmod +x scripts/*.sh

# Copy pre-built agentfs binary (built via scripts/build-agentfs.sh)
COPY bin/agentfs /usr/local/bin/agentfs
RUN chmod +x /usr/local/bin/agentfs

# Default entrypoint is echo-server; DO overrides via this.entrypoint for other modes:
#   bridge:            ["bash", "scripts/entrypoint.sh"]
#   fuse-mount:        ["bash", "scripts/fuse-mount.sh"]
#   hrana-test-client: ["node", "dist/hrana-test-client.js"]
# force-rebuild-2
CMD ["node", "dist/echo-server.js"]
