class BroadcastingChannel {
  onSubscribe() {}

  message() {
    return {};
  }
}

class FooChannel extends BroadcastingChannel {}

class BroadcastingService {
  channels = {
    FooChannel,
  };
}
