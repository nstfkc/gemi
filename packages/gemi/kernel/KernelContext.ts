import { kernelContext } from "./context";

export class KernelContext {
  static getStore = () => kernelContext.getStore();
}
