-- A model whose primary key is a compound `@@id`, so the differential harness
-- has one to compare. Nothing else in this schema does — `SocialAccount`'s
-- composite key is an `@@unique`, which is a different path.

-- CreateTable
CREATE TABLE "Membership" (
    "organizationId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" INTEGER NOT NULL DEFAULT 2,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("organizationId", "userId")
);
