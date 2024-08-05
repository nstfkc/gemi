-- CreateTable
CREATE TABLE "Organization" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "description" TEXT
);

-- CreateTable
CREATE TABLE "OrganizationInvitation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "publicId" TEXT NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "role" INTEGER NOT NULL DEFAULT 2,
    "acceptedAt" DATETIME,
    CONSTRAINT "OrganizationInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "publicId" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerifiedAt" DATETIME,
    "globalRole" INTEGER NOT NULL DEFAULT 2,
    "password" TEXT,
    "organizationId" INTEGER,
    CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Account" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "publicId" TEXT NOT NULL,
    "organizationId" INTEGER,
    "organizationRole" INTEGER NOT NULL DEFAULT 2,
    "userId" INTEGER,
    CONSTRAINT "Account_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "token" TEXT NOT NULL,
    "userId" INTEGER,
    "expiresAt" DATETIME NOT NULL,
    "updatedAt" DATETIME,
    "absoluteExpiresAt" DATETIME NOT NULL,
    "location" TEXT,
    "userAgent" TEXT,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationInvitation_publicId_key" ON "OrganizationInvitation"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "User_publicId_key" ON "User"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_publicId_key" ON "Account"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");
