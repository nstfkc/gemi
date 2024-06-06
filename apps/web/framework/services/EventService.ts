import type { ServerWebSocket } from "bun";

class Event {
  static topic = "ping";

  message(socket: ServerWebSocket) {
    socket.send("pong");
  }
}

export class EventService {
  events = [Event];
}
