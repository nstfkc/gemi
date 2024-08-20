import { prisma } from "@/app/database/prisma";
import { Redirect } from "gemi/facades";
import { Controller } from "gemi/http";

export class HomeController extends Controller {
  public async index() {
    const user = await prisma.user.findFirst();
    return { user };
  }
}
