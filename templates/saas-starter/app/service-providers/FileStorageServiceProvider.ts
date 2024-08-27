import {
  FileStorageServiceProvider,
  FileSystemDriver,
  S3Driver,
} from "gemi/services";

export default class extends FileStorageServiceProvider {
  driver = new FileSystemDriver();
}
