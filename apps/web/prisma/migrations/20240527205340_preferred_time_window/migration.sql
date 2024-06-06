/*
  Warnings:

  - Made the column `preferredTimeWindow` on table `Appointment` required. This step will fail if there are existing NULL values in that column.

*/
-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Appointment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "visitorId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 0,
    "date" DATETIME NOT NULL,
    "alternativeDate" DATETIME NOT NULL,
    "preferredTimeWindow" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Appointment_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "Visitor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Appointment_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Appointment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Appointment" ("alternativeDate", "createdAt", "date", "hostId", "id", "preferredTimeWindow", "productId", "status", "updatedAt", "visitorId") SELECT "alternativeDate", "createdAt", "date", "hostId", "id", "preferredTimeWindow", "productId", "status", "updatedAt", "visitorId" FROM "Appointment";
DROP TABLE "Appointment";
ALTER TABLE "new_Appointment" RENAME TO "Appointment";
PRAGMA foreign_key_check("Appointment");
PRAGMA foreign_keys=ON;
