import { FileStorageDriver } from "./drivers/FileStorageDriver";
import { FileSystemDriver } from "./drivers/FileSystemDriver";

export class FileStorageServiceProvider {
  driver: FileStorageDriver = new FileSystemDriver();
}
