/*
  Warnings:

  - A unique constraint covering the columns `[token]` on the table `Session` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Session_createdAt_token_key";

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");
