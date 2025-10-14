import { ServiceProvider } from "../ServiceProvider";

export class KernelIdServiceProvider extends ServiceProvider {
  id = crypto.randomUUID();
  boot() {}
}
