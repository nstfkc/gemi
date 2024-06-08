import { verify, decode } from "jsonwebtoken";

import { Middleware, getCookies } from "gemi/http";
import { prisma } from "@/app/database/prisma";

export class UserMiddleware extends Middleware {
  override async run(req: Request, ctx: Map<string, any>) {
    const cookies = getCookies(req);
    const accessToken = cookies.get("accessToken");

    if (!accessToken) {
      return {};
    }

    const isValid = verify(accessToken, "SECRET");
    if (!isValid) {
      return {};
    }

    const { userId } = decode(accessToken) as { userId: string };

    const user = await prisma.user.findFirst({
      where: { id: userId },
      select: {
        name: true,
        email: true,
        accounts: { select: { organizationId: true, role: true } },
        globalRole: true,
        id: true,
      },
    });

    ctx.set("user", user);

    return {};
  }
}
