FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    fuse3 \
    git \
    python3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src/ src/
RUN npx tsc

COPY bin/agentfs /usr/local/bin/agentfs
RUN chmod +x /usr/local/bin/agentfs

CMD ["node", "dist/command-server.js"]
