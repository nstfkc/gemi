#!/usr/bin/env bash
#
# Run the model suite against a real Postgres, correctly.
#
#     app/models/postgres.sh                    # the whole suite
#     app/models/postgres.sh app/models/lateral.test.ts
#
# The sequence below is four steps and **all four matter**, which is why this
# file exists. Getting it wrong does not error: the suite runs, the Postgres
# describes skip or fail, and the number at the bottom looks like a result.
#
#   1. a server                    — or every Postgres suite skips
#   2. schema.prisma -> postgresql — or `prisma generate` emits a SQLite client
#   3. db push                     — or the tables are not there
#   4. prisma generate             — or the differential harness compares
#                                    against a client built for the other dialect
#
# I have got this wrong three times in one sitting, each time reading the
# resulting 121 failures as a regression before recognising the shape. A script
# is cheaper than remembering, and it restores `provider = "sqlite"` on the way
# out — leaving it flipped is its own trap, because the SQLite suites then fail
# for a reason that has nothing to do with the change under test.
set -euo pipefail

cd "$(dirname "$0")/../.."

CONTAINER="${GEMI_PG_CONTAINER:-gemi-orm-pg}"
PORT="${GEMI_PG_PORT:-55432}"
URL="postgres://gemi:gemi@localhost:${PORT}/gemi"
STARTED=""

restore() {
  # Always, even on failure. A left-over `postgresql` provider is the trap this
  # script exists to close, so the cleanup cannot be conditional on success.
  sed -i '' 's/provider = "postgresql"/provider = "sqlite"/' prisma/schema.prisma || true
  DATABASE_URL="file:./dev.db" npx prisma generate >/dev/null 2>&1 || true
  if [ -n "$STARTED" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
}
trap restore EXIT

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "==> starting $CONTAINER on :$PORT"
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_PASSWORD=gemi -e POSTGRES_USER=gemi -e POSTGRES_DB=gemi \
    -p "${PORT}:5432" postgres:16 >/dev/null
  STARTED=1
  # Poll rather than sleep a guessed number of seconds.
  for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -U gemi >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

echo "==> pointing schema.prisma at postgresql"
sed -i '' 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma

echo "==> db push + generate"
DATABASE_URL="$URL" npx prisma db push --skip-generate --accept-data-loss >/dev/null
DATABASE_URL="$URL" npx prisma generate >/dev/null

echo "==> vitest"
TZ=UTC TEST_POSTGRES_URL="$URL" bun --bun vitest run --no-file-parallelism \
  "${@:-app/models/}"
