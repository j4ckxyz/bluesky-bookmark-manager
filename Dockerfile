# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 ships prebuilt binaries for common platforms; these are only
# needed when npm has to fall back to compiling it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY server ./server
COPY web ./web
RUN npm run build

# Drop dev dependencies from the tree we are about to copy across.
RUN npm prune --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    WEB_DIR=/app/web/dist

RUN mkdir -p /data && chown -R node:node /data

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist

USER node
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
