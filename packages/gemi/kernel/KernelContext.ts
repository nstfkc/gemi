import { ServiceContainer } from "../services/ServiceContainer";
import { kernelContext } from "./context";

export class KernelContext {
  static getStore = () => kernelContext.getStore();
}
