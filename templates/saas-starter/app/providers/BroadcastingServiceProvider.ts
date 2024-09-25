import { BroadcastingChannel } from "gemi/broadcasting";
import { Auth } from "gemi/facades";
import { BroadcastingServiceProvider } from "gemi/services";

class PrivateChannel extends BroadcastingChannel {
  async subscribe(params: { id: string }) {
    return true;
  }
}

class FooChannel extends PrivateChannel {
  publish(message: string) {
    return { message };
  }
}

export default class extends BroadcastingServiceProvider {
  channels = {
    "/foo/:id": FooChannel,
  };
}
