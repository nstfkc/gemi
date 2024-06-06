import { verify, decode } from "jsonwebtoken";

import { getCookies } from "@/framework/http/helpers/getCookies";
import { AuthenticationError } from "@/framework/Router";
import { Middleware } from "@/framework/http/Middleware";
import { prisma } from "@/app/database/prisma";

export class AuthMiddleware extends Middleware {
  override async run(req: Request, ctx: Map<string, any>) {
    const cookies = getCookies(req);
    const accessToken = cookies.get("accessToken");

    if (!accessToken) {
      throw new AuthenticationError();
    }

    const isValid = verify(accessToken, "SECRET");
    if (!isValid) {
      throw new AuthenticationError();
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
