import { KernelContext } from "../kernel/KernelContext";
import { applyParams } from "../utils/applyParams";

export class Broadcast {
  static publish<T>(route: T, params: any) {
    const channel =
      KernelContext.getStore().broadcastingServiceContainer.service.channels[
        route as any
      ];
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
        KernelContext.getStore().broadcastingServiceContainer.publish(
          topic,
          JSON.stringify({ topic, data: instance.publish(data) }),
          compress,
        );
      },
    };
  }
}
