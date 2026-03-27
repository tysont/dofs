FROM node:22-slim

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ src/
RUN npx tsc

CMD ["node", "dist/echo-server.js"]
