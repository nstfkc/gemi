import { ServiceProvider } from "../ServiceProvider";
import { Sharp } from "./drivers/SharpDriver";

export class ImageOptimizationServiceProvider extends ServiceProvider {
  driver = new Sharp();
  boot() {}
}
