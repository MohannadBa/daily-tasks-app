# syntax=docker/dockerfile:1.7
# Multi-stage build for the NestJS API. Build context: repository root.

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
COPY packages/validation/package.json packages/validation/
COPY apps/api/package.json apps/api/

FROM manifests AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@dailytasks/api..."
COPY packages/config packages/config
COPY packages/database packages/database
COPY packages/shared-types packages/shared-types
COPY packages/validation packages/validation
COPY apps/api apps/api
RUN pnpm --filter "@dailytasks/api^..." run build && pnpm --filter @dailytasks/api run build

FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter "@dailytasks/api..."
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
COPY --from=build --chown=node:node /app/packages/validation/dist packages/validation/dist
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
COPY --chown=node:node docker/api/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini forwards SIGTERM so Nest shutdown hooks run (graceful shutdown).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
