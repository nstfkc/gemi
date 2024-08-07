import { PrismaClient } from "@prisma/client";
import { PrismaLibSQL } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";
import { prismaExtension } from "gemi/app";

const libsql = createClient({
  url: `${process.env.TURSO_DATABASE_URL}`,
  authToken: `${process.env.TURSO_AUTH_TOKEN}`,
});

const adapter = new PrismaLibSQL(libsql);

const prismaGlobal = global as typeof global & {
  prisma?: PrismaClient;
};

const client: PrismaClient =
  prismaGlobal.prisma ??
  new PrismaClient({
    adapter,
    errorFormat: "minimal",
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

const prisma = client.$extends(prismaExtension);

if (process.env.NODE_ENV !== "production") {
  prismaGlobal.prisma = prisma as any;
}

export { prisma };
