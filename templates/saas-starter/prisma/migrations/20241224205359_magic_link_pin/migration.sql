/*
  Warnings:

  - Added the required column `pin` to the `MagicLinkToken` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MagicLinkToken" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "token" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_MagicLinkToken" ("createdAt", "email", "id", "token") SELECT "createdAt", "email", "id", "token" FROM "MagicLinkToken";
DROP TABLE "MagicLinkToken";
ALTER TABLE "new_MagicLinkToken" RENAME TO "MagicLinkToken";
CREATE UNIQUE INDEX "MagicLinkToken_token_key" ON "MagicLinkToken"("token");
CREATE UNIQUE INDEX "MagicLinkToken_email_key" ON "MagicLinkToken"("email");
PRAGMA foreign_key_check("MagicLinkToken");
PRAGMA foreign_keys=ON;
