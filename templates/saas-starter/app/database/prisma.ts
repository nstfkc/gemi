import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const prismaGlobal = global as typeof global & {
  prisma?: PrismaClient;
};

const connectionString = `${process.env.DATABASE_URL}`;

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);

const prisma: PrismaClient =
  prismaGlobal.prisma ??
  new PrismaClient({
    adapter,
    errorFormat: "minimal",
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  prismaGlobal.prisma = prisma as any;
}

export { prisma };
