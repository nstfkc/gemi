import { AuthenticationServiceProvider } from "gemi/kernel";

export default class extends AuthenticationServiceProvider {
  constructor() {
    console.log("AuthServiceProvider");

    super();
  }

  override getUserByEmailAddress(email: string) {
    return { email: `auth:${email}` };
  }
}
