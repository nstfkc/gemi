#!/usr/bin/env bash
#
# Run the model suite against a real Postgres, correctly.
#
#     app/models/postgres.sh                    # the whole suite
#     app/models/postgres.sh app/models/lateral.test.ts
#
# The sequence below is five steps and **all five matter**, which is why this
# file exists. Getting it wrong does not error: the suite runs, the Postgres
# describes skip or fail, and the number at the bottom looks like a result.
#
#   1. a server                    — or every Postgres suite skips
#   2. schema.prisma -> postgresql — or `prisma generate` emits a SQLite client
#   3. db push                     — or the tables are not there
#   4. prisma generate             — or the differential harness compares
#                                    against a client built for the other dialect
#   5. the same two for            — or the scalar-list suite has no models and
#      postgres-only.prisma          skips, which reads exactly like passing
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
# `prisma/postgres-only.prisma` gets a database of its own, not a second set of
# tables in `gemi`. `prisma db push` reconciles a *whole database* to one
# schema, so pushing it alongside would drop every table the main schema owns.
LISTS_URL="postgres://gemi:gemi@localhost:${PORT}/gemi_lists"
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

# The scalar-list schema (#300), in its own database and with its own client.
# `createdb` is idempotent here only because the failure is swallowed: it exists
# after the first run, and re-creating it would be an error rather than a no-op.
echo "==> db push + generate (postgres-only.prisma)"
docker exec "$CONTAINER" createdb -U gemi gemi_lists >/dev/null 2>&1 || true
LISTS_DATABASE_URL="$LISTS_URL" npx prisma db push \
  --schema prisma/postgres-only.prisma --skip-generate --accept-data-loss >/dev/null
LISTS_DATABASE_URL="$LISTS_URL" npx prisma generate \
  --schema prisma/postgres-only.prisma >/dev/null

echo "==> vitest"
TZ=UTC TEST_POSTGRES_URL="$URL" TEST_POSTGRES_LISTS_URL="$LISTS_URL" \
  bun --bun vitest run --no-file-parallelism "${@:-app/models/}"
