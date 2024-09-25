import { ServiceContainer } from "../ServiceContainer";
import { FileStorageServiceProvider } from "./FileStorageServiceProvider";

export class FileStorageServiceContainer extends ServiceContainer {
  static _name = "FileStorageServiceContainer";

  constructor(public service: FileStorageServiceProvider) {
    super();
  }
}
