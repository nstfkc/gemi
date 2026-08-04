import { AsyncLocalStorage } from "node:async_hooks";
import { app } from "../foundation/app";
import { ServiceProvider } from "../support/ServiceProvider";

class WorkflowManager {
  static token = "workflow";

  async getWorkflow(id: string): Promise<Workflow> {
    return new Workflow(id);
  }
  async getWorkflowStep() {}
  async updateWorkflowStep() {}
  async completeWorkflow() {}
}

class WorkflowServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(WorkflowManager, () => new WorkflowManager());
  }
}

const WorkflowContext = new AsyncLocalStorage<{
  workflowId: string;
}>();

class Workflow {
  constructor(public id: string) {}

  handler(..._args: unknown[]) {}

  static sleep(duration: string) {
    Workflow.waitUntil(() => {
      WorkflowContext;
    });
  }

  static waitUntil(fn: () => boolean | Promise<boolean>) {
    Workflow.step("wait-until", fn);
  }

  static step<T>(id: string, handler: T) {}
  static start<T extends new (id: string) => Workflow>(
    this: T,
    id: string,
    ...args: Parameters<InstanceType<T>["handler"]>
  ) {
    const service = app(WorkflowManager);
    const w = new Workflow(id);
    w.handler(...args);
  }
}

class ReminderWorkflow extends Workflow {
  async handler(userId: string) {
    Workflow.step("", () => {});

    Workflow.sleep("1d");

    Workflow.step("", () => {});
  }
}

ReminderWorkflow.start("reminder-workflow", "user-123");
