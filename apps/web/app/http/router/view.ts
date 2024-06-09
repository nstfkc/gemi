import { ViewRouter } from "gemi/http";
import { OrganisationController } from "../controllers/OrganisationController";
import { HostController } from "../controllers/HostController";
import { MapController } from "../controllers/MapController";
import { AuthController } from "../controllers/AuthController";
import { AppointmentController } from "../controllers/AppointmentController";
import { VisitorController } from "../controllers/VisitorController";

class AuthViewRouter extends ViewRouter {
  middlewares = ["user"];

  override routes = {
    "/sign-in": this.view("auth/SignIn", [AuthController, "signInView"]),
    "/sign-up": this.view("auth/SignUp", [AuthController, "signUpView"]),
  };
}

class OrganisationRouter extends ViewRouter {
  override middlewares = ["auth"];

  override routes = {
    "/create": this.view("organisation/CreateOrganisation"),
    "/:organisationId": this.view(
      "organisation/OrganisationLayout",
      [OrganisationController, "show"],
      {
        "/dashboard": this.view("organisation/Dashboard"),
        "/hosts": this.view("organisation/Hosts", [HostController, "list"]),
        "/appointments": this.view("organisation/Appointments", [
          AppointmentController,
          "show",
        ]),
        "/products": this.view("organisation/Products"),
        "/integration": this.view("organisation/Integration"),
      },
    ),
  };
}

export default class extends ViewRouter {
  override routes = {
    "/": this.view("Home"),
    "/map/:organizationId": this.view("Map", [
      MapController,
      "organisationMap",
    ]),
    "/auth": AuthViewRouter,
    "/organisation": OrganisationRouter,
    "/host/appointment/:appointmentId": this.view("HostApproveAppintment", [
      HostController,
      "appointment",
    ]),
    "/visitor/appointment/:appointmentId": this.view(
      "VisitorApproveAppointment",
      [VisitorController, "appointment"],
    ),
  };
}
