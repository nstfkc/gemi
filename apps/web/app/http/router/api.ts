import { ApiRouter } from "gemi/http";
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
      this.post((req) => {
        return { data: { message: req.rawRequest.url } };
      }),
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

export default class extends ApiRouter {
  routes = {
    "/test": this.get((req) => {
      console.log("test");
      return { data: { message: "HI" } };
    }),
  };
}
