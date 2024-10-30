import type {
  IFileStorageDriver,
  ReadFileParams,
  PutFileParams,
} from "./types";

export abstract class FileStorageDriver implements IFileStorageDriver {
  abstract fetch(params: ReadFileParams | string): Promise<Response>;
  abstract put(params: PutFileParams | Blob): Promise<string>;
  abstract list(folder: string): Promise<any>;
}
