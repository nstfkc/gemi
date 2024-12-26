import { Email } from "gemi/email";
import Welcome from "./emails/Welcome";

export class WelcomeEmail extends Email {
  subject = {
    "en-US": "Welcome to our platform",
    "de-DE": "Bienvenue sur notre plateforme",
  };

  template = Welcome;
}
