import { ServiceProvider } from "gemi/support";

/**
 * The application's own service provider. It is registered after the
 * framework's, so anything bound here wins over a framework binding of the
 * same token.
 */
export default class AppServiceProvider extends ServiceProvider {
  /**
   * Bind things into the container. Nothing may be resolved here — the other
   * providers have not necessarily registered yet.
   *
   *   this.app.singleton(Billing, () => new Billing(this.app.config.get("billing", {})));
   *   this.app.bind(Clock, () => new SystemClock());
   */
  register() {}

  /**
   * Runs after every provider has registered, so resolving is safe here. This
   * is where authorization gates and policies, view/route macros and any other
   * cross-cutting wiring belong.
   */
  async boot() {}
}
