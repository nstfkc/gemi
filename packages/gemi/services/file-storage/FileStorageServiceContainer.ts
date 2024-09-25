import { ServiceContainer } from "../ServiceContainer";
import { FileStorageServiceProvider } from "./FileStorageServiceProvider";

export class FileStorageServiceContainer extends ServiceContainer {
  name = "FileStorageServiceContainer";

  constructor(public service: FileStorageServiceProvider) {
    super();
  }
}
