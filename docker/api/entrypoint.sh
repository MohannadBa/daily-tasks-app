#!/bin/sh
# Optional one-off modes so the same image can run migrations/seed (compose "migrate" service, ECS task).
set -e
PRISMA="node /app/node_modules/prisma/build/index.js"
SCHEMA="--schema /app/packages/database/prisma/schema.prisma"

# On ECS, build DATABASE_URL from the injected RDS secret fields (see packages/config ensureDatabaseUrl).
if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-}" ]; then
  DATABASE_URL=$(node -e "require('/app/packages/config/dist').ensureDatabaseUrl();process.stdout.write(process.env.DATABASE_URL)")
  export DATABASE_URL
fi

case "$1" in
  migrate)
    $PRISMA migrate deploy $SCHEMA
    if [ "${SEED_DEMO_DATA:-false}" = "true" ]; then node /app/packages/database/dist/seed.js; fi
    exit 0
    ;;
esac

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  $PRISMA migrate deploy $SCHEMA
fi
exec "$@"
