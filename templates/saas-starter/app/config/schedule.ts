import { defineScheduleConfig } from "gemi/services";

import { TestCron } from "@/app/cron/TestCron";

export default defineScheduleConfig({
  jobs: [TestCron],
});
