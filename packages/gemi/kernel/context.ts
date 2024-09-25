import { AsyncLocalStorage } from "async_hooks";

export const kernelContext = new AsyncLocalStorage();
