import { KernelContext } from "../kernel/KernelContext";
import { BroadcastingServiceContainer } from "../services/pubsub/BroadcastingServiceContainer";
import { applyParams } from "../utils/applyParams";

export class Broadcast {
  static publish<T>(route: T, params: any) {
    const channel =
      BroadcastingServiceContainer.use().service.channels[route as any];
    if (!channel) {
      throw new Error(`Channel ${route} not found`);
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
