// class WorkflowStep {
//   handler() {}
// }

// class Workflow {
//   steps: WorkflowStep[];

//   retry(error: any) {
//     return error.kind !== "foo" || error.kind !== "bar" || error.kind !== "baz";
//   }

//   static pipe(...steps: WorkflowStep[]) {
//     return {
//       Error: class {},
//     };
//   }
// }

// const steps = Workflow.pipe(Step1, Step2, Step3);

// class ProcessPayment extends WorkflowStep {
//   steps = [];

//   retry(error: typeof steps.Error) {
//     return error.kind !== "network_error";
//   }
// }
