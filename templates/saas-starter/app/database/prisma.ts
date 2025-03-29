import { PrismaClient } from "@prisma/client";

const prismaGlobal = global as typeof global & {
  prisma?: PrismaClient;
};

const prisma: PrismaClient =
  prismaGlobal.prisma ??
  new PrismaClient({
    errorFormat: "minimal",
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  prismaGlobal.prisma = prisma as any;
}

export { prisma };
