//@ts-ignore
import sharp from "sharp";

import { Buffer } from "node:buffer";
import type { Prettify } from "../utils/type";

import type {
  PutFileParams,
  ReadFileParams,
} from "../services/file-storage/drivers/types";
import { FilesystemManager } from "../services/file-storage/FilesystemManager";
import { Facade } from "./Facade";

type Metadata = Prettify<sharp.Metadata>;

export class Storage extends Facade {
  static getFacadeAccessor() {
    return FilesystemManager;
  }

  static async put(params: PutFileParams | Blob) {
    return this.getFacadeRoot().driver.put(params);
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
    return this.getFacadeRoot().driver.fetch(params);
  }
  static list(folder: string) {
    return this.getFacadeRoot().driver.list(folder);
  }
  static delete() {}
}
