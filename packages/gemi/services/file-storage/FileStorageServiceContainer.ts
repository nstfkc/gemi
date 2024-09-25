import { ServiceContainer } from "../ServiceContainer";
import { FileStorageServiceProvider } from "./FileStorageServiceProvider";

export class FileStorageServiceContainer extends ServiceContainer {
  name = "fileStorageServiceContainer";

  constructor(public service: FileStorageServiceProvider) {
    super();
  }
}
