import { Kernel } from "gemi/kernel";
import EmailServiceProvider from "../service-providers/EmailServiceProvider";
import AuthenticationServiceProvider from "../service-providers/AuthenticationServiceProvider";

export default class extends Kernel {
  emailServiceProvider = EmailServiceProvider;
  authenticationServiceProvider = AuthenticationServiceProvider;
}
