import { prisma } from "@/app/database/prisma";
import {
  ApiRouter,
  HttpRequest,
  ResourceController,
  type CreateRPC,
} from "gemi/http";
import { Auth, Broadcast, FileStorage } from "gemi/facades";
import { WelcomeEmail } from "@/app/email/WelcomeEmail";
import { FooController } from "../controllers/FooController";

class A extends ApiRouter {
  routes = {
    "/test": this.post(FooController, "index"),
    "/foo": this.resource(FooController),
  };
}

type X = CreateRPC<A>;

export default A;
