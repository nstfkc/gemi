-- A relation joining on two fields, for #67.
--
-- Hand-written to match what `prisma migrate` emits for SQLite: the composite
-- primary key becomes a table-level PRIMARY KEY, and the foreign key names both
-- columns in order.
CREATE TABLE "Ledger" (
    "tenantId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,

    PRIMARY KEY ("tenantId", "code")
);

CREATE TABLE "LedgerEntry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tenantId" INTEGER NOT NULL,
    "ledgerCode" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "memo" TEXT,

    CONSTRAINT "LedgerEntry_tenantId_ledgerCode_fkey" FOREIGN KEY ("tenantId", "ledgerCode") REFERENCES "Ledger" ("tenantId", "code") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "LedgerEntry_tenantId_ledgerCode_idx" ON "LedgerEntry"("tenantId", "ledgerCode");
