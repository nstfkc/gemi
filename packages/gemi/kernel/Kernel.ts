import { AsyncLocalStorage } from "async_hooks";
import { EmailServiceProvider } from "../email/EmailServiceProvider";

interface KernelContext {
  emailServiceProvider: EmailServiceProvider;
}

const context = new AsyncLocalStorage<KernelContext>();

export class Kernel {
  protected emailServiceProvider = EmailServiceProvider;

  static getContext = () => context.getStore();

  run<T>(cb: () => T) {
    return context.run(
      {
        emailServiceProvider: new this.emailServiceProvider(),
      },
      cb,
    );
  }
}
