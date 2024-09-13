export class BroadcastingChannel {
  async subscribe(user: any): Promise<boolean> {
    return true;
  }

  publish(input: any): any {
    return {};
  }
}
