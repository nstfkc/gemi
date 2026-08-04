import { prisma } from "@/app/database/prisma";
import { CronJob } from "gemi/services";

export class TestCron extends CronJob {
  name = "TestCron";
  cron = CronJob.exp("@daily");

  async callback() {
    const users = await prisma.user.findMany({
      select: { email: true },
    });
    console.log("TestCron executed");
    console.log(users.map((user) => user.email));
  }

  async onComplete() {
    console.log("TestCron completed");
  }
}
