import { IAuthenticationAdapter } from "./types";

class AdapterNotFound extends Error {
  constructor() {
    super("Adapter not found");
    this.name = "AdapterNotFound";
  }
}

export class BlankAdapter implements IAuthenticationAdapter {
  // @ts-ignore
  createSession() {
    throw new AdapterNotFound();
  }

  // @ts-ignore
  deleteSession() {
    throw new AdapterNotFound();
  }

  // @ts-ignore
  findSession() {
    throw new AdapterNotFound();
  }

  // @ts-ignore
  findUserByEmailAddress() {
    throw new AdapterNotFound();
  }

  // @ts-ignore
  updateSession() {
    throw new AdapterNotFound();
  }

  // @ts-ignore
  createUser() {
    throw new AdapterNotFound();
  }
}
