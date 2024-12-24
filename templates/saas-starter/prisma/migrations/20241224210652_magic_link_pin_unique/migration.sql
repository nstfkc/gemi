/*
  Warnings:

  - A unique constraint covering the columns `[token,email]` on the table `MagicLinkToken` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[pin,email]` on the table `MagicLinkToken` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "MagicLinkToken_token_key";

-- CreateIndex
CREATE UNIQUE INDEX "MagicLinkToken_token_email_key" ON "MagicLinkToken"("token", "email");

-- CreateIndex
CREATE UNIQUE INDEX "MagicLinkToken_pin_email_key" ON "MagicLinkToken"("pin", "email");
