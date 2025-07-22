import Baker from "cronbake";
import { ServiceProvider } from "../ServiceProvider";
import { CronJob } from "./CronJob";

export class CronServiceProvider extends ServiceProvider {
  driver = Baker.create({ autoStart: true });
  jobs: (new () => CronJob)[] = [];
  boot() {}
}
