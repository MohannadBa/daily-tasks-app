# syntax=docker/dockerfile:1.7
# Multi-stage build for the background worker. Build context: repository root.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@10.34.9
WORKDIR /app

# ---- manifests only, for a cacheable install layer ----
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/config/package.json packages/config/
COPY packages/database/package.json packages/database/
COPY packages/shared-types/package.json packages/shared-types/

COPY apps/worker/package.json apps/worker/

FROM manifests AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@dailytasks/worker..."
COPY packages/config packages/config
COPY packages/database packages/database
COPY packages/shared-types packages/shared-types

COPY apps/worker apps/worker
RUN pnpm --filter "@dailytasks/worker^..." run build && pnpm --filter @dailytasks/worker run build

FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter "@dailytasks/worker..."
COPY packages/database/prisma packages/database/prisma
RUN cd packages/database && npx prisma generate

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app ./
COPY --from=build --chown=node:node /app/packages/config/dist packages/config/dist
COPY --from=build --chown=node:node /app/packages/database/dist packages/database/dist
COPY --from=build --chown=node:node /app/packages/shared-types/dist packages/shared-types/dist

COPY --from=build --chown=node:node /app/apps/worker/dist apps/worker/dist
USER node
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||3002)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini forwards SIGTERM so the worker drains in-flight work (graceful shutdown).
CMD ["node", "apps/worker/dist/main.js"]
