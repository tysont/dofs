FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src/ src/
COPY scripts/ scripts/
RUN npx tsc && chmod +x scripts/entrypoint.sh

# Default entrypoint is echo-server; DO overrides via this.entrypoint for other modes:
#   bridge:            ["bash", "scripts/entrypoint.sh"]
#   hrana-test-client: ["node", "dist/hrana-test-client.js"]
CMD ["node", "dist/echo-server.js"]
