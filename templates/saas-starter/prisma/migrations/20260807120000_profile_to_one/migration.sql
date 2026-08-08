-- A to-one whose foreign key is on the child, so the differential harness has
-- one to compare against Prisma. Every other child-side relation in this schema
-- is a list, which is why the foreign side of a nested write was never measured.
--
-- Not hand-written: this is verbatim what
--
--     prisma migrate diff --from-schema-datamodel <the schema before Profile> \
--                         --to-schema-datamodel prisma/schema.prisma --script
--
-- emits for SQLite on prisma 6.19.2. Two details are worth naming because they
-- are the ones a hand-written version gets wrong. A nullable relation field
-- gets `ON DELETE SET NULL`, not the `ON DELETE RESTRICT` that the required
-- relations in the earlier migrations here carry — so deleting a User orphans
-- its Profile rather than refusing. And the single-field `@unique` becomes a
-- unique index named `<Table>_<column>_key`, which is also what covers the
-- foreign key for `foreign-key-indexes.test.ts`: no separate `@@index` is
-- needed, and adding one would be a second index over the same column.

-- CreateTable
CREATE TABLE "Profile" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "bio" TEXT,
    "userId" INTEGER,
    CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Profile_userId_key" ON "Profile"("userId");
