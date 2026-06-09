import { Service } from "../Injectable";
import { ServiceProvider } from "../ServiceProvider";

export class CustomServiceProvider extends ServiceProvider {
  services = new Map<string, Service>();

  boot() {}
}
