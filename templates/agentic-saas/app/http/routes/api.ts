import { SupportAgentController, supportStore } from "@/app/agents/support";
import { Auth } from "gemi/facades";
import { ApiRouter } from "gemi/http";

export default class extends ApiRouter {
  routes = {
    // One key, four paths: the turn itself, `/attach` to rejoin a run already
    // in progress, `/stop`, and `/files`. The client only ever names this one —
    // `useChat("/support")` finds the rest — and each is guarded on its own
    // because they do not cost the same thing: `upload` takes bytes, `stream`
    // takes model time, `attach` is a read.
    "/support": this.agent(SupportAgentController).middleware({
      stream: "auth",
      attach: "auth",
      stop: "auth",
      upload: "auth",
    }),
    // `this.agent()` deliberately does not mount this one. Minting a thread is
    // where an app records who owns it, and the store has no idea who is
    // asking — so the route is the app's. It is also the only source of an id
    // the store will take: one the client invented is a `thread_not_found` on
    // its first turn.
    "/support/threads": this.post(async () => {
      const user = await Auth.user();
      return supportStore.createThread({ userId: user.id });
    }).middleware("auth"),
  };
}
