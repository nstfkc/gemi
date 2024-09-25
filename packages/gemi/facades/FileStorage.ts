//@ts-ignore
import sharp from "sharp";

import { Buffer } from "node:buffer";
import type { Prettify } from "../utils/type";

import { KernelContext } from "../kernel/KernelContext";
import type {
  PutFileParams,
  ReadFileParams,
} from "../services/file-storage/drivers/types";
import { FileStorageServiceContainer } from "../services/file-storage/FileStorageServiceContainer";

type Metadata = Prettify<sharp.Metadata>;

export class FileStorage {
  static async put(params: PutFileParams | Blob) {
    return FileStorageServiceContainer.use().service.driver.put(params);
  }

  static async metadata(obj: Blob | File): Promise<Partial<Metadata>> {
    const buffer = Buffer.from(await obj.arrayBuffer());
    try {
      return await sharp(buffer).metadata();
    } catch {
      return {};
    }
  }

  static async fetch(params: ReadFileParams | string) {
    return FileStorageServiceContainer.use().service.driver.fetch(params);
  }
  static delete() {}
}
