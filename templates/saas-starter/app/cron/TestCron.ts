import { CronJob } from "gemi/services";

import { User } from "@/app/models/User";

/**
 * A `CronJob` subclass, scheduled by being here.
 *
 * Nothing lists this file. Every class under `app/cron` that extends `CronJob`
 * is scheduled when the kernel boots, which is what keeps a cron job from being
 * written and then never firing: there is no second list to forget.
 *
 * `shouldRun()` decides whether a tick happens at all — override it to keep a
 * job that reports outward from firing off a developer machine. It is left at
 * its default here so this one runs everywhere.
 */
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
