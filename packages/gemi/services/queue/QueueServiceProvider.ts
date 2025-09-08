import { ServiceProvider } from "../ServiceProvider";
import type { Job } from "./Job";

export class QueueServiceProvider extends ServiceProvider {
  jobs: Array<new () => Job> = [];
  concurrency = 1;

  boot() {}
}
