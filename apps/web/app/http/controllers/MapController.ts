import { prisma } from "@/app/database/prisma";
import { Controller } from "gemi/http";

export class MapController extends Controller {
  async organisationMap(req: Request, params: { organizationId: string }) {
    const { organizationId } = params;

    const hosts = await prisma.host.findMany({
      where: {
        organizationId,
      },
      include: {
        address: true,
        HostProducts: {
          include: {
            Product: true,
          },
        },
      },
    });

    return {
      data: {
        hosts,
      },
    };
  }
}
