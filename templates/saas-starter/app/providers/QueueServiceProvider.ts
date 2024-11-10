import { QueueServiceProvider } from "gemi/services";
import { TestJob } from "../jobs/TestJob";

export default class extends QueueServiceProvider {
  jobs = [TestJob];
}
