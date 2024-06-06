import { prisma } from "@/app/database/prisma";
import { Controller } from "@/framework/Controller";
import { Auth } from "@/framework/facades/Auth";
import { HttpRequest } from "@/framework/http/HttpRequest";

class CreateOrganisationRequest extends HttpRequest<{ name: string }> {
  schema = {
    name: {
      required: "Name is required",
      "min:3": "Name must be at least 3 characters",
    },
  };
}

export class OrganisationController extends Controller {
  requests = {
    create: CreateOrganisationRequest,
  };

  public async show(req: Request, params: { organisationId: string }) {
    const organisation = await prisma.organization.findFirst({
      where: {
        id: params.organisationId,
      },
    });
    return {
      data: {
        organisation,
      },
    };
  }

  public async index() {
    const user = Auth.user();
    const organisations = await prisma.organization.findMany({
      where: {
        Account: {},
      },
    });

    return {
      data: {
        organisations,
      },
    };
  }

  async create(req: CreateOrganisationRequest) {
    const user = Auth.user();
    const input = await req.input();
    const data = input.toJSON();

    const organisation = await prisma.organization.create({
      data: {
        name: data.name,
        description: "",
        Account: {
          create: {
            name: user.name,
            userId: user.id,
            role: "OWNER",
          },
        },
      },
    });

    return {
      data: {
        organisation,
      },
    };
  }
}
