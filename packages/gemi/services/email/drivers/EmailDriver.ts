import type { SendEmailParams } from "./types";

export abstract class EmailDriver {
  abstract send(params: SendEmailParams): Promise<boolean> | boolean;
}
