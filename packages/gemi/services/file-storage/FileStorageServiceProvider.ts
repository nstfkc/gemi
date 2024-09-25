import { ServiceProvider } from "../ServiceProvider";
import { FileStorageDriver } from "./drivers/FileStorageDriver";
import { FileSystemDriver } from "./drivers/FileSystemDriver";

export class FileStorageServiceProvider extends ServiceProvider {
  driver: FileStorageDriver = new FileSystemDriver();

  boot() {}
}
