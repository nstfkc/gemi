-- Json and Bytes columns, so the differential harness can compare the two
-- scalar types this schema could not previously reach.
--
-- Nullable, so the migration needs no backfill and existing rows keep the null
-- that Prisma and the ORM both return for an unset column. SQLite types, since
-- `migration_lock.toml` pins this directory to the sqlite provider — Prisma
-- stores Json as TEXT and Bytes as BLOB there.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "metadata" JSONB;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "avatar" BLOB;

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "settings" JSONB;

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "token" BLOB;
