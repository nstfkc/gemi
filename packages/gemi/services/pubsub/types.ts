export type PublishArgs = [
  topic: string,
  data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer,
  compress?: boolean,
];
