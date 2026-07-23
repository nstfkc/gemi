import { BroadcastManager } from "../services/pubsub/BroadcastManager";
import { applyParams } from "../utils/applyParams";
import { Facade } from "./Facade";

export class Broadcast extends Facade {
  static getFacadeAccessor() {
    return BroadcastManager;
  }

  static channel<T>(route: T, params: any) {
    const broadcast = this.getFacadeRoot();
    const channel = broadcast.channels[route as any];
    if (!channel) {
      console.error(`Channel ${route} not found`);
      return {
        publish: () => {},
      };
    }
    const instance = new channel();
    return {
      publish: (
        data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer,
        compress: boolean = false,
      ) => {
        const topic = applyParams(route as any, params);
        broadcast.publish(
          topic,
          JSON.stringify({ topic, data: instance.publish(data) }),
          compress,
        );
      },
    };
  }
}
