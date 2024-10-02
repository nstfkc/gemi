/*
  Warnings:

  - The required column `publicId` was added to the `Organization` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN "verificationToken" TEXT;

-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Organization" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "publicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "description" TEXT
);
INSERT INTO "new_Organization" ("description", "id", "logoUrl", "name") SELECT "description", "id", "logoUrl", "name" FROM "Organization";
DROP TABLE "Organization";
ALTER TABLE "new_Organization" RENAME TO "Organization";
CREATE UNIQUE INDEX "Organization_publicId_key" ON "Organization"("publicId");
PRAGMA foreign_key_check("Organization");
PRAGMA foreign_keys=ON;
