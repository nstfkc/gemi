import { AsyncLocalStorage } from "node:async_hooks";
import { ServiceProvider } from "../services/ServiceProvider";
import { ServiceContainer } from "../services/ServiceContainer";

class WorkflowServiceProvider extends ServiceProvider {
  boot() {}

  async getWorkflow(id: string): Promise<Workflow> {
    return new Workflow(id);
  }
  async getWorkflowStep() {}
  async updateWorkflowStep() {}
  async completeWorkflow() {}
}

class WorkflorServiceContainer extends ServiceContainer {
  static _name = "WorkflorServiceContainer";
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
    const service = WorkflorServiceContainer.use().service;
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
