import { Kernel } from "gemi/kernel";
import EmailServiceProvider from "../service-providers/EmailServiceProvider";

export default class extends Kernel {
  emailServiceProvider = EmailServiceProvider;
}
