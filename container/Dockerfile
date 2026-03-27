FROM node:22-slim

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ src/
RUN npx tsc

# Default entrypoint is echo-server; DO overrides via this.entrypoint for other modes
CMD ["node", "dist/echo-server.js"]
