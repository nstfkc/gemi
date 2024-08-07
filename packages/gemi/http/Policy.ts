export class Policies {
  all(_operation: string, _args: any): Promise<boolean> | boolean {
    return true;
  }
}
