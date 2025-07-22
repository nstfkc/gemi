import { ServiceProvider } from "../ServiceProvider";
import type { CronJob } from "./CronJob";
import type { Kernel } from "../../kernel";

export class CronServiceProvider extends ServiceProvider {
  jobs: (new () => CronJob)[] = [];

  constructor(public kernel: Kernel) {
    super();
  }

  boot() {}
}
