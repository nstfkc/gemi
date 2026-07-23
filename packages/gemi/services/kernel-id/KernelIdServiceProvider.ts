import { ServiceProvider } from "../../support/ServiceProvider";
import { KernelId } from "./KernelId";

// Config-less by nature: the id is generated per process, never declared.
export class KernelIdServiceProvider extends ServiceProvider {
  register() {
    this.app.instance(KernelId, new KernelId());
  }
}
