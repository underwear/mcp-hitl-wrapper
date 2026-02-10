FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts \
 && cd node_modules/better-sqlite3 \
 && npx --yes prebuild-install -r napi || node-gyp rebuild --release

COPY tsconfig.json tsup.config.ts ./
COPY src/ ./src/

RUN npm run build

# Prune dev dependencies
RUN npm prune --production

FROM node:22-alpine

RUN apk add --no-cache tini

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Data directory for audit DB (owned by node so the process can write)
RUN mkdir -p /app/data /app/config && chown -R node:node /app/data /app/config

USER node

VOLUME ["/app/data", "/app/config"]

EXPOSE 8080

# Use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "dist/cli.js", "serve", "--config", "/app/config/config.json"]
