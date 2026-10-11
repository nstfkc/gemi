import type { WebSocketLike } from "../sideband";

/**
 * A WebSocket the test drives: `serverOpen`, `serverSend`, `serverClose`. Hand
 * `fakeSocketFactory` to a `RealtimeClient` or a sideband as `webSocket`.
 */
export class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  closedWith?: { code?: number; reason?: string };
  private handlers: Record<string, ((event: any) => void)[]> = {};

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {
    FakeSocket.all.push(this);
  }

  static last(): FakeSocket {
    return FakeSocket.all[FakeSocket.all.length - 1]!;
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    (this.handlers[type] ??= []).push(listener);
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send before open");
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.closedWith = { code, reason };
    this.serverClose(code ?? 1000, reason ?? "");
  }

  serverOpen(): void {
    this.readyState = 1;
    this.fire("open", {});
  }
  serverSend(event: Record<string, unknown> | string): void {
    this.fire("message", { data: typeof event === "string" ? event : JSON.stringify(event) });
  }
  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.fire("close", { code, reason });
  }
  private fire(type: string, event: any): void {
    for (const handler of this.handlers[type] ?? []) handler(event);
  }
}

export const fakeSocketFactory = (url: string, init: { headers: Record<string, string> }) =>
  new FakeSocket(url, init.headers);
