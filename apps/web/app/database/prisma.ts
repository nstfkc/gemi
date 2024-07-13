import { PrismaClient } from '@prisma/client'

const prismaClientPropertyName = `__prevent-name-collision__prisma`
type GlobalThisWithPrismaClient = typeof globalThis & {
  [prismaClientPropertyName]: PrismaClient
}

const getPrismaClient = () => {
  if (process.env.NODE_ENV === `production`) {
    return new PrismaClient()
  } else {
    const globalWithPrisma = globalThis as GlobalThisWithPrismaClient
    if (!globalWithPrisma[prismaClientPropertyName]) {
      globalWithPrisma[prismaClientPropertyName] = new PrismaClient()
    }
    return globalWithPrisma[prismaClientPropertyName]
  }
}

export const prisma = getPrismaClient()