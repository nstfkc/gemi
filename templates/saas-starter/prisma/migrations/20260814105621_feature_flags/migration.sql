-- CreateTable
CREATE TABLE "FeatureFlag" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "publicId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "offValue" JSONB,
    "defaultValue" JSONB,
    "rules" JSONB,
    "seed" TEXT NOT NULL,
    "bucketBy" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_publicId_key" ON "FeatureFlag"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_key" ON "FeatureFlag"("key");

-- CreateIndex
CREATE INDEX "FeatureFlag_archivedAt_idx" ON "FeatureFlag"("archivedAt");
