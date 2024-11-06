import { KernelContext } from "../kernel/KernelContext";
import { BroadcastingServiceContainer } from "../services/pubsub/BroadcastingServiceContainer";
import { applyParams } from "../utils/applyParams";

export class Broadcast {
  static channel<T>(route: T, params: any) {
    const channel =
      BroadcastingServiceContainer.use().service.channels[route as any];
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
        BroadcastingServiceContainer.use().publish(
          topic,
          JSON.stringify({ topic, data: instance.publish(data) }),
          compress,
        );
      },
    };
  }
}
