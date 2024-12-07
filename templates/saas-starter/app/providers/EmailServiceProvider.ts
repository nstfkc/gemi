import { EmailServiceProvider, ResendDriver } from "gemi/services";

export default class extends EmailServiceProvider {
  driver = new ResendDriver();
}
