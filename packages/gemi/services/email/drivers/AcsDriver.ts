import type {
  EmailAttachment,
  EmailDeliveryResult,
  SendEmailParams,
} from "./types";
import { EmailDriver } from "./EmailDriver";

/**
 * The slice of `@azure/communication-email` this driver uses. Declared
 * structurally so the package stays an optional peer dependency: nothing here
 * imports its types.
 */
export interface AcsEmailAddress {
  address: string;
  displayName?: string;
}

export interface AcsEmailMessage {
  senderAddress: string;
  content: { subject: string; html?: string; plainText?: string };
  recipients: {
    to: AcsEmailAddress[];
    cc?: AcsEmailAddress[];
    bcc?: AcsEmailAddress[];
  };
  replyTo?: AcsEmailAddress[];
  headers?: Record<string, string>;
  attachments?: Array<{
    name: string;
    contentType: string;
    contentInBase64: string;
  }>;
}

interface AcsPollerLike {
  getOperationState?(): { status?: string; error?: unknown } | undefined;
  getResult?(): { id?: string } | undefined;
}

export interface AcsEmailClientLike {
  beginSend(
    message: AcsEmailMessage,
    options?: { operationId?: string },
  ): Promise<AcsPollerLike>;
}

export interface AcsDriverConfig {
  /**
   * The Communication Services endpoint, e.g.
   * `https://<resource>.communication.azure.com`. With it the driver
   * authenticates with `credential`, or `DefaultAzureCredential` from
   * `@azure/identity` (managed identity in Azure, `az login` locally).
   * Defaults to `process.env.AZURE_COMMUNICATION_ENDPOINT`.
   */
  endpoint?: string;
  /** A `TokenCredential` or `AzureKeyCredential` used with `endpoint`. */
  credential?: unknown;
  /**
   * Used when there is no endpoint. Defaults to
   * `process.env.AZURE_COMMUNICATION_CONNECTION_STRING`.
   */
  connectionString?: string;
  /**
   * A pre-built `EmailClient`. Supply this to configure retries, proxies or a
   * credential yourself — the driver then never imports the SDK. Tests pass a
   * fake here.
   */
  client?: AcsEmailClientLike;
}

/** `"Ada <ada@example.com>"` → `{ address, displayName }`. */
export function parseAcsAddress(value: string): AcsEmailAddress {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (!match) return { address: value.trim() };
  const [, displayName, address] = match;
  return displayName
    ? { address: address.trim(), displayName }
    : { address: address.trim() };
}

function contentTypeOf(attachment: EmailAttachment) {
  if (attachment.contentType) return attachment.contentType;
  // Bun maps the extension without touching the disk. Parameters such as
  // `;charset=utf-8` are dropped: ACS validates the bare MIME type.
  const type = Bun.file(attachment.filename).type.split(";")[0];
  return type || "application/octet-stream";
}

/**
 * Azure Communication Services Email.
 *
 * `@azure/communication-email` (and `@azure/identity` for managed identity) are
 * optional peer dependencies, loaded on the first send, so apps that don't use
 * ACS never install them.
 *
 * - ACS has no idempotency keys: `params.idempotencyKey` is ignored
 *   (`supportsIdempotencyKey` is `false`). Dedupe retries in the app.
 * - ACS has no scheduled send: a `scheduledAt` is refused with an error.
 * - `id` is the send's operation id. The driver doesn't wait for the operation
 *   to finish; delivery is reported through Event Grid.
 */
export class AcsDriver extends EmailDriver {
  override readonly provider = "acs";
  override readonly supportsIdempotencyKey = false;

  private clientPromise: Promise<AcsEmailClientLike> | null = null;

  constructor(private config: AcsDriverConfig = {}) {
    super();
  }

  private async client(): Promise<AcsEmailClientLike> {
    if (this.config.client) return this.config.client;

    // Memoized so concurrent sends share one client, and one import.
    this.clientPromise ??= (async () => {
      let sdk: any;
      try {
        // @ts-ignore - optional peer dependency, absent unless the app installs it
        sdk = await import("@azure/communication-email");
      } catch {
        throw new Error(
          "AcsDriver requires the '@azure/communication-email' package. Install it with `bun add @azure/communication-email`, or pass a pre-built `client`.",
        );
      }

      const endpoint =
        this.config.endpoint ?? process.env.AZURE_COMMUNICATION_ENDPOINT;
      const connectionString =
        this.config.connectionString ??
        process.env.AZURE_COMMUNICATION_CONNECTION_STRING;

      if (endpoint) {
        let credential = this.config.credential;
        if (!credential) {
          let identity: any;
          try {
            // @ts-ignore - optional peer dependency, absent unless the app installs it
            identity = await import("@azure/identity");
          } catch {
            throw new Error(
              "AcsDriver with an `endpoint` and no `credential` requires the '@azure/identity' package (for DefaultAzureCredential). Install it with `bun add @azure/identity`.",
            );
          }
          credential = new identity.DefaultAzureCredential();
        }
        return new sdk.EmailClient(endpoint, credential);
      }
      if (connectionString) {
        return new sdk.EmailClient(connectionString);
      }
      throw new Error(
        "AcsDriver needs an endpoint (AZURE_COMMUNICATION_ENDPOINT, authenticated with managed identity), a connection string (AZURE_COMMUNICATION_CONNECTION_STRING), or a `client`.",
      );
    })();

    // A failed setup (missing package or config) isn't cached, so fixing the
    // environment doesn't need a restart.
    this.clientPromise.catch(() => {
      this.clientPromise = null;
    });

    return this.clientPromise;
  }

  /** The ACS message for `params`. */
  static toMessage(params: SendEmailParams): AcsEmailMessage {
    const message: AcsEmailMessage = {
      // ACS takes the bare address; the display name comes from the sender
      // username configured on the domain.
      senderAddress: parseAcsAddress(params.from).address,
      content: {
        subject: params.subject,
        html: params.html,
        ...(params.text ? { plainText: params.text } : {}),
      },
      recipients: {
        to: params.to.map(parseAcsAddress),
        ...(params.cc?.length ? { cc: params.cc.map(parseAcsAddress) } : {}),
        ...(params.bcc?.length ? { bcc: params.bcc.map(parseAcsAddress) } : {}),
      },
    };

    if (params.replyTo?.length) {
      message.replyTo = params.replyTo.map(parseAcsAddress);
    }
    if (params.headers && Object.keys(params.headers).length) {
      message.headers = params.headers;
    }
    if (params.attachments?.length) {
      message.attachments = params.attachments.map((attachment) => ({
        name: attachment.filename,
        contentType: contentTypeOf(attachment),
        contentInBase64: Buffer.from(attachment.content).toString("base64"),
      }));
    }

    return message;
  }

  async send(params: SendEmailParams) {
    return (await this.deliver(params)).ok;
  }

  override async deliver(params: SendEmailParams): Promise<EmailDeliveryResult> {
    if (params.scheduledAt) {
      throw new Error(
        `AcsDriver can't schedule a send (scheduledAt: "${params.scheduledAt}"): Azure Communication Services has no scheduled delivery. Send from a delayed job instead.`,
      );
    }

    const message = AcsDriver.toMessage(params);
    const client = await this.client();
    // Our own operation id, so the id is known without waiting on the poller.
    const operationId = crypto.randomUUID();

    try {
      // `beginSend` resolves once ACS has accepted the request; the poller is
      // dropped without `pollUntilDone`, so the send doesn't wait for delivery.
      const poller = await client.beginSend(message, { operationId });
      const state = poller.getOperationState?.();
      if (state?.status === "failed" || state?.status === "canceled") {
        console.error(state.error);
        return { ok: false, id: operationId, error: state.error };
      }
      return { ok: true, id: poller.getResult?.()?.id ?? operationId };
    } catch (error) {
      console.error(error);
      return { ok: false, id: null, error };
    }
  }
}
