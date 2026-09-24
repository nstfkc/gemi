-- A social account is identified by (provider, providerId), not by
-- (username, provider). The old key made two different Google accounts with the
-- same display name collide, and did not constrain the one value that is stable.
--
-- `providerId` becomes nullable because the OAuth callback used to write `""`
-- there, and a unique index cannot hold more than one of those per provider.
-- Legacy empty values are carried over as NULL (which a unique index treats as
-- distinct) rather than invented from names or emails. The callback claims a
-- legacy row with the real identifier on its user's next sign-in.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SocialAccount" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "providerId" TEXT,
    "username" TEXT,
    "email" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SocialAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_SocialAccount" ("accessToken", "createdAt", "email", "expiresAt", "id", "provider", "providerId", "refreshToken", "updatedAt", "userId", "username") SELECT "accessToken", "createdAt", "email", "expiresAt", "id", "provider", NULLIF("providerId", ''), "refreshToken", "updatedAt", "userId", "username" FROM "SocialAccount";
DROP TABLE "SocialAccount";
ALTER TABLE "new_SocialAccount" RENAME TO "SocialAccount";
CREATE INDEX "SocialAccount_userId_idx" ON "SocialAccount"("userId");
CREATE UNIQUE INDEX "SocialAccount_provider_providerId_key" ON "SocialAccount"("provider", "providerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
