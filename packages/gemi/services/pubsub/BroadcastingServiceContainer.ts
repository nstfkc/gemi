import type { ServerWebSocket } from "bun";
import { ServiceContainer } from "../ServiceContainer";
import { BroadcastingServiceProvider } from "./BroadcastingServiceProvider";
import type { PublishArgs } from "./types";
import { AsyncLocalStorage } from "async_hooks";

type PublishCallback = (...args: PublishArgs) => void;

export class BroadcastingServiceContainer extends ServiceContainer {
  name = "BroadcastingServiceContainer";
  publishCb: PublishCallback;
  context = new AsyncLocalStorage<{
    headers: Headers;
    cookies: Map<string, string>;
  }>();

  constructor(public service: BroadcastingServiceProvider) {
    super();
  }

  onPublish(cb: PublishCallback) {
    this.publishCb = cb;
  }

  publish(...args: PublishArgs) {
    const [topic, data, compress] = args;
    this.publishCb(topic, data, compress);
  }

  async handleMessage(
    ws: ServerWebSocket<{ headers: Headers }>,
    message: string | Buffer,
  ) {
    const messageData = JSON.parse(message as string);
    if (messageData.type === "subscribe") {
      const sortedChannels = Object.entries(this.service.channels).sort(
        ([keyA], [keyB]) => keyA.length - keyB.length,
      );
      for (const [pathname, Channel] of sortedChannels) {
        const urlPattern = new URLPattern({ pathname });
        if (urlPattern.test({ pathname: messageData.topic })) {
          const params = urlPattern.exec({ pathname: messageData.topic })
            ?.pathname.groups!;
          const instance = new Channel();
          const canSubscribe = await instance.subscribe.call(instance, params);
          if (canSubscribe) {
            ws.subscribe(messageData.topic);
          }
        }
        break;
      }
    }
    if (messageData.type === "broadcast") {
      ws.publish(
        messageData.topic,
        JSON.stringify({ topic: messageData.topic, data: messageData.payload }),
      );
    }
    if (messageData.type === "unsubscribe") {
      ws.unsubscribe(messageData.topic);
    }
  }

  run(headers: Headers, fn: VoidFunction) {
    const cookie = headers.get("Cookie");
    const cookies = new Map();
    if (cookie) {
      const cookieArray = cookie.split(";");
      for (const c of cookieArray) {
        const [key, value] = c.split("=");
        cookies.set(key.trim(), value.trim());
      }
    }
    this.context.run({ headers, cookies }, fn);
  }
}
