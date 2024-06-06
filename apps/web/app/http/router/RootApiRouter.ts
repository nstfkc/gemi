import { ApiRouter } from "@/framework/ApiRouter";
import { AuthController } from "../controllers/AuthController";
import { OrganisationController } from "../controllers/OrganisationController";
import { AppointmentController } from "../controllers/AppointmentController";
import { HostController } from "../controllers/HostController";
import { VisitorController } from "../controllers/VisitorController";

class AuthApiRouter extends ApiRouter {
  override routes = {
    "/sign-up": this.post(AuthController, "signUp"),
    "/sign-in": this.post(AuthController, "signIn"),
    "/sign-out": this.post(AuthController, "signOut"),
  };
}

class OrganisationApiRouter extends ApiRouter {
  middlewares = ["auth"];

  override routes = {
    "/": [
      this.get(OrganisationController, "index"),
      this.post(OrganisationController, "create"),
    ],
    "/:organisationId/appointment/:hostId": this.post(
      AppointmentController,
      "create",
    ),
  };
}

class HostRouter extends ApiRouter {
  routes = {
    "/appointment/:appointmentId": this.post(
      HostController,
      "approveAppointment",
    ),
  };
}

class VisitorRouter extends ApiRouter {
  routes = {
    "/appointment/:appointmentId": this.post(
      VisitorController,
      "approveAppointment",
    ),
  };
}

export class RootApiRouter extends ApiRouter {
  override routes = {
    "/auth": AuthApiRouter,
    "/organisation": OrganisationApiRouter,
    "/host": HostRouter,
    "/visitor": VisitorRouter,
  };
}
