import { Email } from "gemi/email";
import Welcome from "./emails/Welcome";

export class WelcomeEmail extends Email {
  subject = "Welcome here";
  template = Welcome;
}
