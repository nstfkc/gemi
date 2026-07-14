import { Singleton } from "../Singleton";
import { ServiceProvider } from "../ServiceProvider";

export class SingletonServiceProvider extends ServiceProvider {
  services = new Map<string, Singleton>();

  boot() {}
}
