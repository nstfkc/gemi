import { CronJob } from "gemi/services";

import { User } from "@/app/models/User";

export class TestCron extends CronJob {
  name = "TestCron";
  cron = CronJob.exp("@daily");

  async callback() {
    const users = await User.findMany({
      select: { email: true },
    });
    console.log("TestCron executed");
    console.log(users.map((user) => user.email));
  }

  async onComplete() {
    console.log("TestCron completed");
  }
}
