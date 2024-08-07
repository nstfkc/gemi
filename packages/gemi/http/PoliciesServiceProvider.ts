import { Policies } from "./Policy";

export class PoliciesServiceProvider {
  policiesList: Record<string, Policies> = {};
  constructor() {
    const policies = this.register();
    for (const Policy of policies) {
      const policy = new Policy();
      this.policiesList[Policy.name] = policy;
    }
  }

  protected register(): Array<new () => Policies> {
    return [];
  }
}
