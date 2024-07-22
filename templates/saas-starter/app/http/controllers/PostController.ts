import { prisma } from "@/app/database/prisma";
import { type Prisma } from "@prisma/client";

import { HttpRequest, ResourceController } from "gemi/http";

export class PostController extends ResourceController {
  async list() {
    return await prisma.post.findMany({ include: { author: true } });
  }

  async show(req: HttpRequest<{}, { id: string }>) {
    return await prisma.post.findUnique({
      where: { publicId: req.params.id },
      include: { author: true },
    });
  }

  async create(req: HttpRequest<Prisma.PostCreateInput, {}>) {
    const input = await req.input();
    return await prisma.post.create({ data: input.toJSON() });
  }

  async update(req: HttpRequest<Prisma.PostUpdateInput, { id: string }>) {
    const input = await req.input();
    return await prisma.post.update({
      where: { publicId: req.params.id },
      data: input.toJSON(),
    });
  }

  async delete(req: HttpRequest<{}, { id: string }>) {
    return await prisma.post.delete({ where: { publicId: req.params.id } });
  }
}
