export interface PutFileParams {
  name: string;
  bucket?: string;
  body: Blob | File | Buffer;
  contentType?: string;
}

export interface ReadFileParams {
  name: string;
  bucket?: string;
}

export interface FileMetadata {
  width: number;
  height: number;
}

export interface IFileStorageDriver {
  fetch(input: ReadFileParams | string): Promise<Response>;
  put(params: PutFileParams | Blob): Promise<string>;
}
