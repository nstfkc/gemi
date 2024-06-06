/*
  Warnings:

  - Made the column `organizationId` on table `Host` required. This step will fail if there are existing NULL values in that column.

*/
-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Host" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "description" TEXT,
    "organizationId" TEXT NOT NULL,
    "hostAddressId" TEXT NOT NULL,
    CONSTRAINT "Host_hostAddressId_fkey" FOREIGN KEY ("hostAddressId") REFERENCES "HostAddress" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Host_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Host" ("description", "email", "hostAddressId", "id", "name", "organizationId", "phone") SELECT "description", "email", "hostAddressId", "id", "name", "organizationId", "phone" FROM "Host";
DROP TABLE "Host";
ALTER TABLE "new_Host" RENAME TO "Host";
PRAGMA foreign_key_check("Host");
PRAGMA foreign_keys=ON;
