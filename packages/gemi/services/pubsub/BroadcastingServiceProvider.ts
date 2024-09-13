import { ServiceProvider } from "../ServiceProvider";
import { BroadcastingChannel } from "../../broadcasting/BroadcastingChannel";
import { UrlParser } from "../../client/types";

type Channels = Record<string, new () => BroadcastingChannel>;

export class BroadcastingServiceProvider extends ServiceProvider {
  channels: Record<string, new () => BroadcastingChannel> = {};

  boot() {}
}

type Parser<T extends Channels> = {
  [K in keyof T]: InstanceType<T[K]>["publish"] extends (p: infer P) => infer O
    ? { params: UrlParser<`${K & string}`>; input: P; output: O }
    : never;
};

type X = Parser<InstanceType<typeof BroadcastingServiceProvider>["channels"]>;
