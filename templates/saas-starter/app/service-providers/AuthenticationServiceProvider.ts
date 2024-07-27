import { Temporal } from "temporal-polyfill";

import { AuthenticationServiceProvider } from "gemi/kernel";
import { prisma } from "../database/prisma";
import type { User, Prisma } from "@prisma/client";

export default class extends AuthenticationServiceProvider {
  async findUserByEmailAddress(email: string) {
    return await prisma.user.findUnique({
      where: {
        email,
      },
    });
  }

  async createUser(data: Prisma.UserCreateInput) {
    return await prisma.user.create({
      data,
    });
  }

  async createSession(user: User) {
    return await prisma.session.create({
      data: {
        userId: user.id,
        expiresAt: Temporal.Now.instant().add({ hours: 24 }).toString(),
      },
    });
  }

  async verifySession(token: string) {
    const session = await prisma.session.findUnique({
      where: {
        token,
      },
      include: { user: true },
    });

    if (!session) {
      return null;
    }

    if (
      Temporal.Now.instant().until(
        Temporal.Instant.from(session.expiresAt.toISOString()),
      ).sign <= 0
    ) {
      return null;
    }

    return session?.user;
  }

  async deleteSession(token: string) {
    await prisma.session.delete({
      where: {
        token,
      },
    });
  }
}
