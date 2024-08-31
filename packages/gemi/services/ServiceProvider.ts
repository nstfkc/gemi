export abstract class ServiceProvider {
  abstract boot(p: any): Promise<any> | any;
}
