import { Job } from "gemi/services";

export class TestJob extends Job {
  static name = "TestJob";
  worker = true;

  run(args: any) {
    console.log("TestJob done", args);
  }

  onSuccess(result: any, args: any) {
    console.log("TestJob succeeded", { result, args });
  }

  onFail(error: any, args: any) {
    console.log("TestJob failed", error, args);
  }
}
