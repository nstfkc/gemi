-- The two composite relations a nested write can *detach* through, so the
-- differential harness can reach the operands #271 implements. `LedgerEntry`
-- has a required composite key, and Prisma leaves `disconnect` out of a
-- required relation's nested input type entirely — so `disconnect`, `set` and
-- the displacement branches were unreachable from this schema in the same way
-- the foreign side of a to-one was before `Profile`.
--
-- Not hand-written: verbatim what
--
--     prisma migrate diff --from-schema-datamodel <the schema before these> \
--                         --to-schema-datamodel prisma/schema.prisma --script
--
-- emits for SQLite on prisma 6.19.2. Two details are the ones a hand-written
-- version gets wrong, and both are load-bearing for what is being tested. The
-- foreign key is a **two-column** constraint referencing a two-column primary
-- key, `("tenantId", "ledgerCode") REFERENCES "Ledger" ("tenantId", "code")` —
-- one constraint, not two. And `ON DELETE SET NULL` follows from the columns
-- being nullable, which is exactly the property that makes a detach expressible
-- at all.
--
-- `LedgerSeal`'s `@@unique` becomes a two-column unique index rather than a
-- pair of single-column ones. That index *is* the composite one-to-one: it is
-- what makes a second link a collision, and what `planOwningSide`'s `displaces`
-- has to recognise as covering exactly the relation's own fields.

-- CreateTable
CREATE TABLE "LedgerNote" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tenantId" INTEGER,
    "ledgerCode" TEXT,
    "body" TEXT NOT NULL,
    CONSTRAINT "LedgerNote_tenantId_ledgerCode_fkey" FOREIGN KEY ("tenantId", "ledgerCode") REFERENCES "Ledger" ("tenantId", "code") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LedgerSeal" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tenantId" INTEGER,
    "ledgerCode" TEXT,
    "seal" TEXT NOT NULL,
    CONSTRAINT "LedgerSeal_tenantId_ledgerCode_fkey" FOREIGN KEY ("tenantId", "ledgerCode") REFERENCES "Ledger" ("tenantId", "code") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "LedgerNote_tenantId_ledgerCode_idx" ON "LedgerNote"("tenantId", "ledgerCode");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerSeal_tenantId_ledgerCode_key" ON "LedgerSeal"("tenantId", "ledgerCode");
