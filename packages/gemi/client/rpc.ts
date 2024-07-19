import type { ApiRouterHandler } from "../http/ApiRouter";

export interface RPC {}

// export type Parse<T extends RPC> = {
//   queries: {
//     [K in keyof T as K extends `GET:${string}` ? K : never]: T[K];
//   };
//   mutations: {
//     [K in keyof T as K extends `GET:${string}` ? never : K]: T[K];
//   };
// };
